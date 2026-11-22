// The relay on AWS Lambda behind a function URL (see aws/template.yaml).
//
// Several instances may run at once, so the snapshot and the claim on the
// upstream budget live in one small DynamoDB table; the PRIM key is read from
// an SSM SecureString. The AWS SDK comes with the Lambda Node.js runtime:
// nothing to install.

import { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { Relay } from "./core.mjs";

const TableName = process.env.TABLE;
const db = new DynamoDBClient({});
const key = (pk) => ({ pk: { S: pk } });

class DynamoStore {
  async read() {
    const { Item } = await db.send(new GetItemCommand({ TableName, Key: key("snapshot"), ConsistentRead: true }));
    return Item ? { body: Buffer.from(Item.body.B), fetchedAt: Number(Item.fetchedAt.N) } : null;
  }

  async write(snapshot) {
    const Item = { ...key("snapshot"), body: { B: snapshot.body }, fetchedAt: { N: String(snapshot.fetchedAt) } };
    await db.send(new PutItemCommand({ TableName, Item }));
  }

  /** One conditional write: it goes through only if the standing claim is older than the window. */
  async claim(now, gapMs) {
    try {
      await db.send(
        new PutItemCommand({
          TableName,
          Item: { ...key("claim"), at: { N: String(now) } },
          ConditionExpression: "attribute_not_exists(pk) OR #at <= :limit",
          ExpressionAttributeNames: { "#at": "at" },
          ExpressionAttributeValues: { ":limit": { N: String(now - gapMs) } },
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        }),
      );
      return { ok: true };
    } catch (e) {
      if (e?.name !== "ConditionalCheckFailedException") throw e;
      return { ok: false, at: Number(e.Item?.at?.N ?? now), error: e.Item?.error?.S ?? null };
    }
  }

  async fail(error) {
    await db.send(
      new UpdateItemCommand({
        TableName,
        Key: key("claim"),
        UpdateExpression: "SET #error = :error",
        ExpressionAttributeNames: { "#error": "error" },
        ExpressionAttributeValues: { ":error": { S: error } },
      }),
    );
  }

  async status() {
    const { Item } = await db.send(new GetItemCommand({ TableName, Key: key("claim"), ConsistentRead: true }));
    return Item ? { at: Number(Item.at.N), error: Item.error?.S ?? null } : null;
  }
}

let relay;
function ready() {
  relay ??= (async () => {
    const ssm = new SSMClient({});
    const out = await ssm.send(new GetParameterCommand({ Name: process.env.KEY_PARAMETER, WithDecryption: true }));
    const seconds = (name, fallback) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback) * 1000;
    return new Relay({
      key: out.Parameter.Value.trim(),
      refreshMs: seconds("REFRESH_SECONDS", 90),
      maxStaleMs: seconds("MAX_STALE_SECONDS", 300),
      store: new DynamoStore(),
    });
  })().catch((e) => {
    relay = undefined; // try again on the next request rather than fail for the life of the instance
    throw e;
  });
  return relay;
}

export async function handler(event) {
  try {
    const r = await (await ready()).handle(event.requestContext?.http?.method ?? "GET", event.rawPath ?? "/", event.headers ?? {});
    return { statusCode: r.status, headers: r.headers, body: r.body.toString("base64"), isBase64Encoded: true };
  } catch (e) {
    console.error("unexpected error:", e?.name, e?.message);
    return {
      statusCode: 500,
      headers: { "access-control-allow-origin": "*", "content-type": "application/json", "cache-control": "no-store" },
      body: '{"error":"internal"}',
    };
  }
}
