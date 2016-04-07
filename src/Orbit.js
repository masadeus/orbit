'use strict';

const fs           = require('fs');
const path         = require('path');
const EventEmitter = require('events').EventEmitter;
const async        = require('asyncawait/async');
const await        = require('asyncawait/await');
const logger       = require('orbit-common/lib/logger');
const OrbitDB      = require('orbit-db');
const Post         = require('orbit-db/src/post/Post');
const Network      = require('./NetworkConfig');
const utils        = require('./utils');

class Orbit {
  constructor(ipfs, events) {
    this.ipfs = ipfs;
    this.orbit = null;
    this.events = events;
    this._channels = {};
  }

  connect(host, username, password) {
    const hostname = host.split(":")[0];
    const port = host.split(":")[1];
    // const network = { host: hostname, port: port };
    // TODO: hard coded until UI is fixed
    var network = Network.fromFile(path.resolve(utils.getAppPath(), "network.json"));
    const user = { username: username, password: password };
    try {
      logger.info(`Connecting to network at '${network.host}:${network.port}' as '${user.username}`);
      const cacheFile = path.resolve(utils.getAppPath(), "orbit-db-cache.json");
      logger.debug("Load cache from:", cacheFile);
      this.orbit = await(OrbitDB.connect(network.host, network.port, user.username, user.password, this.ipfs, { cacheFile: cacheFile }));
      this.orbit.events.on('data', this._handleMessage.bind(this));
      this.orbit.events.on('load', this._handleStartLoading.bind(this));
      this.orbit.events.on('loaded', this._handleStopLoading.bind(this));
      logger.info(`Connected to '${this.orbit.network.name}' at '${this.orbit.network.host}:${this.orbit.network.port}' as '${user.username}`)
      this.events.emit('network', this.orbit);
    } catch(e) {
      this.orbit = null;
      this._handleError(e);
    }
  }

  disconnect() {
    if(this.orbit) {
      this.orbit.events.removeListener('message', this._handleMessage);
      this.orbit.events.removeListener('load', this._handleStartLoading);
      this.orbit.events.removeListener('loaded', this._handleStopLoading);
      logger.warn(`Disconnected from '${this.orbit.network.name}' at '${this.orbit.network.host}:${this.orbit.network.port}'`);
      this.orbit.disconnect();
      this.orbit = null;
      this._channels = {};
      this.events.emit('network', this.orbit);
    }
  }

  getChannels(callback) {
    const channels = Object.keys(this._channels)
      .map((f) => this._channels[f])
      .map((f) => { return { name: f.name, password: f.password } });

    if(callback) callback(channels);

    return channels;
  }

  join(channel, password, callback) {
    logger.debug(`Join #${channel}`);
    if(!this._channels[channel]) {
      const db = this.orbit.channel(channel, password);
      this._channels[channel] = { name: channel, password: password, db: db };
      this.events.emit('channels.updated', this.getChannels());
    }
    if(callback) callback(null, { name: channel, modes: {} })
  }

  leave(channel) {
    if(this._channels[channel]) {
      this._channels[channel].db.close();
      delete this._channels[channel];
      logger.debug("Left channel #" + channel);
      this.events.emit('channels.updated', this.getChannels());
    }
  }

  getUser(hash, callback) {
    // TODO: return user id from ipfs hash (user.id)
    if(callback) callback(this.orbit.user.id);
  }

  getSwarmPeers(callback) {
    this.ipfs.swarm.peers().then((peers) => {
      if(callback) callback(peers.Strings);
    });
  }

  getMessages(channel, lessThanHash, greaterThanHash, amount, callback) {
    logger.debug(`Get messages from #${channel}: ${lessThanHash}, ${greaterThanHash}, ${amount}`)
    let options = { limit: amount };
    if(lessThanHash) options.lt = lessThanHash;
    if(greaterThanHash) options.gte = greaterThanHash;
    const messages = this._channels[channel].db.iterator(options).collect();
    if(callback) callback(channel, messages);
  }

  getPost(hash, callback) {
    try {
      this.ipfs.object.get(hash).then((res) => {
        if(callback) callback(null, JSON.parse(res.Data));
      });
    } catch(e) {
      this._handleError(e);
      if(callback) callback(e.message, null);
    }
  }

  sendMessage(channel, message, callback) {
    if(message.startsWith('/') && !message.startsWith('/me')) {
      // TODO: do commands
      logger.debug(`#{channel} - Command: ${message}`)
    } else {
      // Treat everything else as sending a message to the channel
      try {
        logger.debug(`Send message to #${channel}: ${message}`);
        const data = {
          content: message,
          from: this.orbit.user.id
        };
        Post.create(this.ipfs, Post.Types.Message, data).then((post) => {
          this._channels[channel].db.add(post.Hash);
          if(callback) callback(null);
        });
      } catch(e) {
        this._handleError(e);
        if(callback) callback(e.message);
      }
    }
  }

  addFile(channel, filePath, callback) {
    const addToIpfs = async((ipfs, filePath) => {
      if(!fs.existsSync(filePath))
        throw "File not found at '" + filePath + "'";

      var hash = await (this.ipfs.add(filePath, { recursive: true }));

      // FIXME: ipfs-api returns an empty dir name as the last hash, ignore this
      if(hash[hash.length-1].Name === '')
        return hash[hash.length-2].Hash;

      return hash[hash.length-1].Hash;
    });

    logger.info("Adding file from path '" + filePath + "'");
    var isDirectory = await (utils.isDirectory(filePath));
    var hash = await (addToIpfs(this.ipfs, filePath));
    var size = await (utils.getFileSize(filePath));
    logger.info("Added local file '" + filePath + "' as " + hash);

    const data = {
      name: filePath.split("/").pop(),
      hash: hash,
      size: size,
      from: this.orbit.user.id
    };

    const type = isDirectory ? Post.Types.Directory : Post.Types.File;
    Post.create(this.ipfs, type, data).then((post) => {
      this._channels[channel].db.add(post.Hash);
      if(callback) callback(null);
    });
  }

  getDirectory(hash, callback) {
    try {
      this.ipfs.ls(hash).then((result) => {
        if(result.Objects && callback)
          callback(result.Objects[0].Links);
      });
    } catch(e) {
      this._handleError(e);
      if(callback) callback(null);
    }
  }

  /* Properties */
  get user() {
    return this.orbit.user;
  }

  get network() {
    return this.orbit.network;
  }

  /* External event handlers */
  onSocketConnected(socket) {
    this.events.emit('network', this.orbit);
  }

  /* Internal event handlers */
  _handleError(e) {
    logger.error(e.message);
    logger.debug("Stack trace:\n", e.stack);
    this.events.emit('orbit.error', e.message);
  }

  _handleMessage(channel, message) {
    this.events.emit('message', channel, message);
  }

  _handleStartLoading(action, channel) {
    this.events.emit('db.load', action, channel)
  }

  _handleStopLoading(action, channel) {
    this.events.emit('db.loaded', action, channel)
  }

}

module.exports = Orbit;
