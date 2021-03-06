import { homedir } from 'os';
import { join, dirname } from 'path';
import {
    mkdirSync, existsSync, writeFile, writeFileSync,
    readdirSync, unlinkSync, rmdirSync } from 'fs';
import * as tf from '@tensorflow/tfjs-node';
import fetch from 'node-fetch';
import { parse as parseURL } from 'url';

/**
 * Represent Node-Red's runtime
 */
type NodeRed = {
  nodes: NodeRedNodes;
};

type NodeRedWire = {
  [index: number]: string;
};

type NodeRedWires = {
  [index: number]: NodeRedWire;
};

type CacheEntry = {
  hash: string;
  lastModified: string;
  filename: string;
};

type CacheEntries = {
  [url: string] : CacheEntry;
};

// Where we store all data for tf-model custom node
const CACHE_DIR = join(homedir(), '.node-red', 'tf-model');
// Make sure the CACHE_DIR exists
mkdirSync(CACHE_DIR, {recursive: true});

// A JSON file to store all the cached models
const MODEL_CACHE_ENTRIES = join(CACHE_DIR, 'models.json');
// Load cached model entries
const gModelCache: CacheEntries = existsSync(MODEL_CACHE_ENTRIES) ?
    require(MODEL_CACHE_ENTRIES) : {};

if (Object.getOwnPropertyNames(gModelCache).length === 0) {
  updateCacheEntries(MODEL_CACHE_ENTRIES);
}
/**
 * Represent Node-Red's configuration for a custom node
 * For this case, it's the configuration for tf-model node
 */
type NodeRedProperties = {
  id: string;
  type: string;
  name: string;
  modelURL: string;
  outputNode: string;
  wires: NodeRedWires;
};

/**
 * Represent Node-Red's nodes
 */
type NodeRedNodes = {
  // tslint:disable-next-line:no-any
  createNode(node: any, props: NodeRedProperties): void;
  // tslint:disable-next-line:no-any
  registerType(type: string, ctor: any): void;
};

/**
 * Represent Node-Red's message that passes to a node
 */
type NodeRedReceivedMessage = {
  payload: tf.NamedTensorMap;
};

type NodeRedSendMessage = {
  payload: tf.Tensor | tf.Tensor[];
};

type StatusOption = {
  fill: 'red' | 'green' | 'yellow' | 'blue' | 'grey';
  shape: 'ring' | 'dot';
  text: string;
};

type ModelJSON = {
  weightsManifest: [ { paths: string[]}];
};

/**
 * Update cache entry file with current caching
 */
function updateCacheEntries(filename: string) {
  writeFileSync(
      filename,
      JSON.stringify(gModelCache, null, 2),
  );
}

/**
 * Calculate string's hash code
 * @param str string to calculate its hash code
 */
function hashCode(str: string): string {
  let hash = 0, i, chr;
  if (str === undefined || str.length === 0) {
    return `${hash}`;
  }
  for (i = 0; i < str.length; i++) {
    chr   = str.charCodeAt(i);
    hash  = ((hash << 5) - hash) + chr | 0;
  }
  return `${hash}`;
}

/**
 * Fetch a single file from the target url and store it into the specified path.
 * And return the file path.
 * @param url target url
 * @param filePath where to store the fetched file
 */
function fetchAndStore(url: string, filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    fetch(url).then(res => res.buffer())
        .then((buff) => {
          writeFile(filePath, buff, (err) => {
            if (err) {
              reject(err);
            } else {
              resolve(filePath);
            }
          });
        });
  });
}

/**
 * Fetch model files, including model.json and shard files to the specified
 * directory. Also add a cache entry into caching
 * @param url model.json file
 * @param modelFolder store model files in this directory
 */
function fetchNewModelFiles(url: string) {
  let filename: string;
  let modelFile: string;
  const hash = hashCode(url);
  const modelFolder = join(CACHE_DIR, hash);
  return fetch(url)
    .then((res) => {
      // all model file will be stored as model.json for now
      // TODO: need to support saved model as well
      filename = 'model.json';
      gModelCache[url] = {
        hash,
        lastModified: res.headers.get('last-modified'),
        filename
      };
      return res.buffer();
    })
    // store the model.json and retrieve shared file list
    .then((body) => {
      return new Promise((resolve, reject) => {
        mkdirSync(modelFolder, { recursive: true });
        modelFile = join(modelFolder, filename);
        writeFile(modelFile, body, (err) => {
          if (err) {
            reject(err);
          } else {
            updateCacheEntries(MODEL_CACHE_ENTRIES);
            resolve(require(modelFile));
          }
        });
      });
    })
    // store all shared files
    .then((model: ModelJSON) => {
      if (model.weightsManifest !== undefined) {
        const parsedURL = parseURL(url);
        const dir = dirname(parsedURL.pathname);
        const allFetch: Array<Promise<string>> = [];
        model.weightsManifest[0].paths.forEach((shardFile) => {
          parsedURL.pathname = `${dir}/${shardFile}`;
          allFetch.push(
              fetchAndStore(
                  `${parsedURL.protocol}//${parsedURL.host}${parsedURL.pathname}`,
                  join(modelFolder, shardFile)));
        });
        return Promise.all(allFetch);
      }
      return Promise.resolve([]);
    })
    .then(() => modelFile);
}

// Clean up the cache entry and model files
function removeCacheEntry(urlStr: string) {
  const entry = gModelCache[urlStr];
  if (entry !== undefined) {
    const modelFolder = join(CACHE_DIR, entry.hash);
    const files = readdirSync(modelFolder);
    files.forEach((file) => {
      unlinkSync(join(modelFolder, file));
    });
    rmdirSync(modelFolder);
    delete gModelCache[urlStr];
    updateCacheEntries(MODEL_CACHE_ENTRIES);
  }
}

function downloadOrUpdateModelFiles(urlStr: string, cacheFirst = true)
    : Promise<string> {

  // support local file://
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch (e) {
    return Promise.reject('Invalid URL');
  }

  if (url.protocol === 'file:') {
    return Promise.resolve(url.pathname);
  }

  const cacheEntry = gModelCache[urlStr];
  if (cacheEntry !== undefined) {
    return fetch(urlStr, {
          headers: { 'If-Modified-Since': cacheEntry.lastModified },
          method: 'HEAD',
        })
        .then((res) => {
          if(res.status === 304) {
            return join(CACHE_DIR, cacheEntry.hash, cacheEntry.filename);
          } if (res.status === 200) {
            // fetch updated model files
            return fetchNewModelFiles(urlStr);
          } else {
            if (cacheFirst) {
              // Unable to know if there is updated version
              // Use the existing cache entry instead
              return join(CACHE_DIR, cacheEntry.hash, cacheEntry.filename);
            }
            throw new Error(`can not retrieve model: ${res.statusText}`);
          }
        })
        .catch((e) => {
          throw e;
        });
  } else {
    // let's fetch the model
    return fetchNewModelFiles(urlStr);
  }
}

// Module for a Node-Red custom node
export = function tfModel(RED: NodeRed) {

  class TFModel {
    // tslint:disable-next-line:no-any
    on: (event: string, fn: (msg: any) => void) => void;
    send: (msg: NodeRedSendMessage) => void;
    status: (option: StatusOption) => void;
    log: (msg: string) => void;
    error: (msg: string) => void;

    id: string;
    type: string;
    name: string;
    wires: NodeRedWires;
    modelURL: string;
    model: tf.GraphModel;
    outputNode: string;

    constructor(config: NodeRedProperties) {
      this.id = config.id;
      this.type = config.type;
      this.name = config.name;
      this.wires = config.wires;
      this.modelURL = config.modelURL;
      this.outputNode = config.outputNode || '';

      RED.nodes.createNode(this, config);
      this.on('input', (msg: NodeRedReceivedMessage) => {
        this.handleRequest(msg.payload);
      });

      this.on('close', (done: () => void) => {
        this.handleClose(done);
      });

      if (this.modelURL.trim().length > 0) {
        downloadOrUpdateModelFiles(this.modelURL)
        .then((modelPath) => {
            this.status({fill:'red' ,shape:'ring', text:'loading model...'});
            this.log(`loading model from: ${this.modelURL}`);
            return tf.loadGraphModel(tf.io.fileSystem(modelPath));
        })
        .then((model: tf.GraphModel) => {
          this.model = model;
          this.status({
            fill:'green',
            shape:'dot',
            text:'model is ready'
          });
          this.log(`model loaded`);
          this.log(`input(s) for the model: ${JSON.stringify(this.model.inputNodes)}`);
        })
        .catch((e: Error) => {
          this.error(e.message);
          this.status({
            fill:'red',
            shape:'dot',
            text:`failed to load the model: ${e.message}`
          });
          this.handleError(e);
        });
      }
    }

    // handle a single request
    handleRequest(inputs: tf.NamedTensorMap) {
      if (!this.model) {
        this.error(`model is not ready`);
        return;
      }

      this.model.executeAsync(inputs, this.outputNode).then((result) => {
        this.send({payload: result});
        this.cleanUp(inputs);
      })
      .catch((e: Error) => {
        this.error(e.message);
        this.cleanUp(inputs);
      });
    }

    // handle error properly
    handleError(error: Error) {
      const msg = error.message || '';
      if (msg.indexOf(
          'byte length of Float32Array should be a multiple of 4') !== -1) {
        // Clear the cache entry and re-download the model next time
        removeCacheEntry(this.modelURL);
        this.error('Model files are corrupted, restart this node to redownload the model again');
      }
    }

    cleanUp(tensors: tf.NamedTensorMap) {
        // Clean up the NamedTensorMap here
        for(const one in tensors) {
          tensors[one].dispose();
        }
    }

    handleClose(done: () => void) {
      // node level clean up
      if (this.model) {
        this.model.dispose();
      }
      done();
    }
  }

  RED.nodes.registerType('tf-model', TFModel);
};
