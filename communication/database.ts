/// <reference lib="deno.unstable" />

import { ResourceLoader } from "../helpers/loader.ts";
import type { MessageView } from "./types.ts";
import { ulid } from "ulid";

const USER_KEY = "user";
const USER_TOKEN_KEY = "user_tk";
const ROOM_WITH_ACTIVITY_KEY = "room_act";
const ROOM_WITH_NAME_KEY = "room_name";
const MESSAGE_KEY = "msg";
const NEXT_ROOM_ID_KEY = "next_room_id";

export interface DatabaseUser {
  userId: number;
  userName: string;
  avatarUrl: string;
}

export interface Message {
  message: string;
  from: {
    username: string;
    avatarUrl: string;
  };
  createdAt: string;
}

export interface Room {
  roomId: number;
  name: string;
  createdAt: string;
  lastMessageAt: string | undefined;
}

export class Database {
  #client: Deno.Kv;

  constructor(client: Deno.Kv) {
    this.#client = client;
  }

  async insertUser(user: DatabaseUser & { accessToken: string }) {
    const newUser = {
      ...user,
      createdAt: new Date().toISOString(),
    };

    const kv = this.#client;
    await kv.atomic()
      .check({ key: [USER_KEY, user.userId], versionstamp: null })
      .set([USER_KEY, user.userId], newUser)
      .set([USER_TOKEN_KEY, user.accessToken], user.userId)
      .commit();
  }

  async getUserByAccessTokenOrThrow(
    accessToken: string,
  ): Promise<DatabaseUser> {
    const user = await this.getUserByAccessToken(accessToken);
    if (user == null) {
      throw new Error("Could not find user with access token.");
    }
    return user;
  }

  async getUserByAccessToken(
    accessToken: string,
  ): Promise<DatabaseUser | undefined> {
    const userIdEntry = await this.#client.get<number>([
      USER_TOKEN_KEY,
      accessToken,
    ]);
    if (userIdEntry.value !== null) {
      const userEntry = await this.#client.get<DatabaseUser>([
        USER_KEY,
        userIdEntry.value,
      ]);
      if (userEntry.value !== null) {
        return userEntry.value;
      }
    }
    return undefined;
  }

  async getRooms(): Promise<Room[]> {
    const roomsEntries = this.#client.list<Room>({
      prefix: [ROOM_WITH_ACTIVITY_KEY],
    });

    const rooms: Room[] = [];
    for await (const entry of roomsEntries) {
      if (entry.value !== null) {
        rooms.push(entry.value);
      }
    }
    return rooms;
  }

  async getRoomName(roomId: number): Promise<string> {
    const roomEntry = await this.#client.get<Room>([
      ROOM_WITH_ACTIVITY_KEY,
      roomId,
    ]);
    if (roomEntry.value === null) {
      return "";
    }
    return roomEntry.value.name;
  }

  async getRoomByName(name: string) {
    const roomEntry = await this.#client.get<Room>([ROOM_WITH_NAME_KEY, name]);
    if (roomEntry.value === null) {
      return undefined;
    }
    return roomEntry.value;
  }

  async nextRoomId(): Promise<number> {
    const nextRoomIdEntry = await this.#client.get<Deno.KvU64>([
      NEXT_ROOM_ID_KEY,
    ]);
    if (nextRoomIdEntry.value === null) {
      throw new Error("Next room id not found");
    }
    // cast from bigint to number
    const roomId = Number(nextRoomIdEntry.value.value);
    const res = await this.#client.atomic()
      .check(nextRoomIdEntry)
      .mutate({
        type: "sum",
        key: nextRoomIdEntry.key,
        value: new Deno.KvU64(1n),
      })
      .commit();
    if (!res.ok) {
      throw new Error(`Failed to increment roomId: ${roomId}`);
    }

    return roomId;
  }

  async findOrInsertRoom(name: string): Promise<Room> {
    const newRoom: Room = {
      roomId: await this.nextRoomId(),
      name,
      createdAt: new Date().toISOString(),
      lastMessageAt: undefined,
    };

    const primaryKey = [ROOM_WITH_ACTIVITY_KEY, newRoom.roomId];
    const secondaryKey = [ROOM_WITH_NAME_KEY, name];

    const res = await this.#client.atomic()
      .check({ key: primaryKey, versionstamp: null })
      .check({ key: secondaryKey, versionstamp: null })
      .set(primaryKey, newRoom)
      .set(secondaryKey, newRoom)
      .commit();

    if (res.ok) {
      return newRoom;
    } else {
      const roomEntry = await this.#client.get<Room>(secondaryKey);
      if (roomEntry.value === null) {
        throw new Error("faild to insert new room");
      }
      return roomEntry.value;
    }
  }

  async ensureRoom(name: string) {
    const room = await this.findOrInsertRoom(name);
    return room.roomId;
  }

  async insertMessage(
    message: { text: string; roomId: number; user: DatabaseUser },
  ) {
    const messageId = ulid();
    const newMessage = {
      message: message.text,
      from: {
        userId: message.user.userId,
        username: message.user.userName,
        avatarUrl: message.user.avatarUrl,
      },
      createdAt: new Date().toISOString(),
    };
    const roomEntry = await this.#client.get<Room>([
      ROOM_WITH_ACTIVITY_KEY,
      message.roomId,
    ]);
    if (roomEntry.value === null) {
      throw new Error("Room not found");
    }
    const room = roomEntry.value;

    await this.#client
      .atomic()
      .set([MESSAGE_KEY, message.roomId, messageId], newMessage)
      .set([ROOM_WITH_ACTIVITY_KEY, message.roomId], {
        ...room,
        lastMessageAt: newMessage.createdAt,
      })
      .commit();
  }

  async getRoomMessages(roomId: number): Promise<MessageView[]> {
    const messageEntries = await this.#client.list<Message>({
      prefix: [MESSAGE_KEY, roomId],
    });
    const messages: MessageView[] = [];
    for await (const entry of messageEntries) {
      if (entry.value !== null) {
        const currentMessage = {
          message: entry.value.message,
          from: {
            name: entry.value.from.username,
            avatarUrl: entry.value.from.avatarUrl,
          },
          createdAt: entry.value.createdAt,
        };
        messages.push(currentMessage);
      }
    }
    return messages;
  }
}

export const databaseLoader = new ResourceLoader<Database>({
  async load() {
    const kv = await Deno.openKv();

    const newRoom: Room = {
      roomId: 0,
      name: "Lobby",
      createdAt: new Date().toISOString(),
      lastMessageAt: undefined,
    };
    const primaryKey = [ROOM_WITH_ACTIVITY_KEY, newRoom.roomId];
    const secondaryKey = [ROOM_WITH_NAME_KEY, newRoom.name];

    const res = await kv.atomic()
      .check({ key: primaryKey, versionstamp: null })
      .check({ key: secondaryKey, versionstamp: null })
      .set(primaryKey, newRoom)
      .set(secondaryKey, newRoom)
      .commit();

    if (!res.ok) {
      console.error("Failed to create lobby room");
    }

    const res2 = await kv.atomic()
      .check({ key: [NEXT_ROOM_ID_KEY], versionstamp: null })
      .set([NEXT_ROOM_ID_KEY], new Deno.KvU64(1n))
      .commit();

    if (!res2.ok) {
      console.error("Failed to create roomId counter");
    }

    return Promise.resolve(new Database(kv));
  },
});
