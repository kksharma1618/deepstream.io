'use strict'

exports.get = function (key, callback) {
  console.log("localstorage.get", arguments);
  callback(null, null)
}

exports.type = 'no storage connector specified'
exports.set = function (key, value, callback) {
  console.log("localstorage.set", arguments);
  callback(null)
}
exports.delete = function (key, callback) {
  console.log("localstorage.delete", arguments);
  callback(null)
}
exports.isReady = true
