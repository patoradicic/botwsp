import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import { MongoClient } from 'mongodb';

const DEFAULT_COLLECTION = 'baileys_auth';

function serialize(data) {
  return JSON.stringify(data, BufferJSON.replacer);
}

function deserialize(raw) {
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw, BufferJSON.reviver) : raw;
}

/**
 * Crea un adaptador de auth state para Baileys persistido en MongoDB.
 * Guarda `creds` y cada clave (`${type}-${id}`) en la colección `baileys_auth`
 * usando `BufferJSON` para preservar Buffers binarios intactos.
 *
 * @param {string} mongoUri URI de conexión a MongoDB (ej: MongoDB Atlas)
 * @param {Object} [options]
 * @param {import('mongodb').Collection} [options.collection] Colección ya instanciada (útil para tests)
 * @param {import('mongodb').MongoClient} [options.client] Cliente MongoClient ya conectado (no se cierra en `close()`)
 * @param {string} [options.dbName] Nombre de base de datos (si no se especifica, usa la de la URI)
 * @param {string} [options.collectionName] Nombre de colección (default: `baileys_auth`)
 */
export async function useMongoAuthState(mongoUri, options = {}) {
  const { collection: providedCollection, client: providedClient, dbName, collectionName = DEFAULT_COLLECTION } = options;

  let ownClient = null;
  let collection = providedCollection ?? null;

  if (!collection) {
    let client = providedClient;
    if (!client) {
      if (!mongoUri) {
        throw new Error('useMongoAuthState requiere mongoUri, options.client u options.collection');
      }
      ownClient = new MongoClient(mongoUri, {
        maxPoolSize: 5,
        serverSelectionTimeoutMS: 15_000,
      });
      await ownClient.connect();
      client = ownClient;
    }
    const db = dbName ? client.db(dbName) : client.db();
    collection = db.collection(collectionName);
  }

  try {
    const writeData = async (id, data) => {
      await collection.updateOne(
        { _id: id },
        { $set: { data: serialize(data), updatedAt: new Date() } },
        { upsert: true }
      );
    };

    const readData = async (id) => {
      const doc = await collection.findOne({ _id: id });
      return deserialize(doc?.data);
    };

    const creds = (await readData('creds')) || initAuthCreds();

    return {
      state: {
        creds,
        keys: {
          get: async (type, ids) => {
            if (!ids?.length) return {};
            const docIds = ids.map((id) => `${type}-${id}`);
            const docs = await collection.find({ _id: { $in: docIds } }).toArray();
            const byId = new Map(docs.map((doc) => [doc._id, doc.data]));

            const data = {};
            for (const id of ids) {
              let value = deserialize(byId.get(`${type}-${id}`));
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value ?? null;
            }
            return data;
          },
          set: async (data) => {
            const ops = [];
            const now = new Date();
            for (const category in data) {
              for (const id in data[category]) {
                const key = `${category}-${id}`;
                const value = data[category][id];
                if (value !== null && value !== undefined) {
                  ops.push({
                    updateOne: {
                      filter: { _id: key },
                      update: { $set: { data: serialize(value), updatedAt: now } },
                      upsert: true,
                    },
                  });
                } else {
                  ops.push({ deleteOne: { filter: { _id: key } } });
                }
              }
            }
            if (ops.length > 0) {
              await collection.bulkWrite(ops, { ordered: false });
            }
          },
        },
      },
      saveCreds: () => writeData('creds', creds),
      clearState: () => collection.deleteMany({}),
      close: async () => {
        if (ownClient) {
          await ownClient.close();
          ownClient = null;
        }
      },
    };
  } catch (err) {
    if (ownClient) {
      await ownClient.close().catch(() => {});
    }
    throw err;
  }
}
