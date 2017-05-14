'use strict'

const LocalCache = function () {
  this.isReady = true
  this._data = {}
  this.type = 'local cache'
}

LocalCache.prototype.set = function (key, value, callback) {
  console.log("localcache.set", arguments);
  this._data[key] = value
  callback(null)
}

LocalCache.prototype.get = function (key, callback) {
  // console.log("localcache.get", key, this._data[key]);
  callback(null, this._data[key] || null)
}

LocalCache.prototype.delete = function (key, callback) {
  // console.log("localcache.delete", key);
  delete this._data[key]
  callback(null)
}

module.exports = new LocalCache()
