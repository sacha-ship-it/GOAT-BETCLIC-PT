'use strict';
const { initialState, migrate } = require('./game');
const fs = require('node:fs/promises');
const path = require('node:path');
class Store {
  constructor(directory) {
    this.directory = directory;
    this.filename = path.join(directory, 'goat-data.json');
    this.queue = Promise.resolve();
    this.state = null;
  }
  async init() {
    await fs.mkdir(this.directory, { recursive: true });
    try {
      const data = JSON.parse( await fs.readFile(this.filename, 'utf8'));
      this.state = migrate(data);
    } catch (e) {
      // Ne jamais remplacer une sauvegarde illisible.
      if (e.code !== 'ENOENT') throw e;
      this.state = initialState();
      await this.write(this.state);
    }
  }
  async write(data) {
    const temp = this.filename + '.tmp';
    const handle = await fs.open(temp, 'w', 0o600);
    try {
      await handle.writeFile(JSON.stringify(data));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.copyFile( this.filename, this.filename + '.bak');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    await fs.rename(temp, this.filename);
    const directory = await fs.open(this.directory, 'r');
    try {
      await directory.sync();
    } catch (e) {
      if (!['EINVAL', 'ENOTSUP'].includes(e.code)) throw e;
    } finally {
      await directory.close();
    }
  }
  async read() {
    await this.queue;
    return structuredClone(this.state);
  }
  change(fn) {
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.state);
      const result = await fn(next);
      await this.write(next);
      this.state = next;
      return structuredClone(result);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  async close() {
    await this.queue;
  }
}
function createStore(env = process.env) {
  const directory =
    env.DATA_DIR ||
    env.RAILWAY_VOLUME_MOUNT_PATH ||
    './data';
  if ( env.RAILWAY_ENVIRONMENT_ID &&
    !env.RAILWAY_VOLUME_MOUNT_PATH) {
    throw new Error( 'Adiciona um volume Railway ao serviço antes de iniciar.');
  }
  if ( env.RAILWAY_VOLUME_MOUNT_PATH &&
    path.resolve(directory) !==
    path.resolve(env.RAILWAY_VOLUME_MOUNT_PATH)) {
    throw new Error( 'DATA_DIR tem de corresponder ao caminho do volume Railway.');
  }
  return new Store(directory);
}

module.exports = { Store, createStore };
