import { assert, BufReader, Deferred, deferred } from "../../deps.ts";
import { MongoError, MongoErrorInfo } from "../error.ts";
import { Document } from "../types.ts";
import { handshake } from "./handshake.ts";
import { parseHeader } from "./header.ts";
import { deserializeMessage, Message, serializeMessage } from "./message.ts";

type Socket = Deno.Reader & Deno.Writer;
interface CommandTask {
  requestId: number;
  db: string;
  body: Document;
}

let nextRequestId = 0;

export class WireProtocol {
  #socket: Socket;
  #isPendingResponse = false;
  #isPendingRequest = false;
  #pendingResponses: Map<number, Deferred<Message>> = new Map();
  #reader: BufReader;
  #commandQueue: CommandTask[] = [];

  #connectionId: number = 0;

  constructor(socket: Socket) {
    this.#socket = socket;
    this.#reader = new BufReader(this.#socket);
  }

  async connect() {
    const { connectionId } = await handshake(this);
    this.#connectionId = connectionId;
  }

  async commandSingle<T = Document>(db: string, body: Document): Promise<T> {
    const [doc] = await this.command<MongoErrorInfo | T>(db, body);
    const maybeError = doc as MongoErrorInfo;
    if (maybeError.ok === 0) {
      throw new MongoError(maybeError);
    }
    return doc as T;
  }

  async command<T = Document>(db: string, body: Document): Promise<T[]> {
    const requestId = nextRequestId++;
    const commandTask = {
      requestId,
      db,
      body,
    };

    this.#commandQueue.push(commandTask);
    this.send();

    this.#pendingResponses.set(requestId, deferred());
    this.receive();
    const message = await this.#pendingResponses.get(requestId);

    let documents: T[] = [];

    message?.sections.forEach((section) => {
      if ("document" in section) {
        documents.push(section.document as T);
      } else {
        documents = documents.concat(section.documents as T[]);
      }
    });

    return documents;
  }

  private async send() {
    if (this.#isPendingRequest) return;
    this.#isPendingRequest = true;
    while (this.#commandQueue.length > 0) {
      const task = this.#commandQueue.shift()!;
      const chunks = serializeMessage({
        requestId: task.requestId,
        responseTo: 0,
        sections: [
          {
            document: {
              ...task.body,
              $db: task.db,
            },
          },
        ],
      });

      for (const chunk of chunks) {
        await Deno.writeAll(this.#socket, chunk);
      }
    }
    this.#isPendingRequest = false;
  }

  private async receive() {
    if (this.#isPendingResponse) return;
    this.#isPendingResponse = true;
    while (this.#pendingResponses.size > 0) {
    }
    this.#isPendingResponse = false;
  }
}
