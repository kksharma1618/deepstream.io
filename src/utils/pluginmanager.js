'use strict'
const fs = require('fs')
const path = require('path')
const EventEmitterGrouped = require('event-emitter-grouped')

const noop = function() {}

// scanning algo taken from https://github.com/easeway/js-plugins
// if package.json exists in each scanned dir
//  - and it has "name"
//  - and it has "is_deepstream_plugin" set to true
//  - and requiring that plugin creates a module with "registerPlugin" function
// then its a plugin. registerPlugin will be called with event-emitter-grouped object and options if any provided in main config
// host will emitSerial or emitParallel on event-emitter-groupe object for various plugin hooks/filters

module.exports = class PluginManager {
  constructor(config) {

    this._config = config;
    this._enabled = !!this._config.enabled;
    if (this._enabled) {
      this._emitter = new EventEmitterGrouped()
      let host = {
        emitter: this._emitter,
        config
      };
      if (config.pluginsDir) {
        scanSubdirsAndRegister(config.pluginsDir, host);
      } else {
        scanAndRegister(host)
      }
    }
  }

  getEmitter() {
    return this._emitter;
  }

  isEnabled() {
    return this._enabled;
  }

  // next can be called both synchronously or asynchronously
  emitSerial(eventId, args, next) {
    if (!next && typeof (args) == "function") {
      next = args;
      args = undefined;
    }
    if (!this.isEnabled()) {
      return next && next();
    }
    next = next || noop;
    this._emitter.emitSerial(eventId, args, next)
  }

  // next can be called both synchronously or asynchronously
  emitParallel(eventId, args, next) {
    if (!next && typeof (args) == "function") {
      next = args;
      args = undefined;
    }
    if (!this.isEnabled()) {
      return next && next();
    }
    next = next || noop;
    this._emitter.emitParallel(eventId, args, next)
  }

}

function scanAndRegister(host) {
  // scan directories are in reverse order of
  // module loading
  var dirs = [],
    mainDir;
  process.config && process.config.variables &&
  dirs.push(path.join(process.config.variables.node_prefix, 'lib/node_modules'));
  if (process.env.HOME) {
    dirs.push(path.join(process.env.HOME, '.node_libraries'));
    dirs.push(path.join(process.env.HOME, '.node_modules'));
  }
  if (require.main && Array.isArray(require.main.paths)) {
    dirs = dirs.concat(require.main.paths.slice().reverse());
    require.main.paths[0] && (mainDir = path.dirname(require.main.paths[0]));
  }
  scanSubdirsAndRegister(dirs, host);
  mainDir && loadPackageAndRegister(mainDir, host);
}
function scanSubdirsAndRegister(dirs, host) {
  Array.isArray(dirs) || (dirs = [dirs]);
  for (var n in dirs) {
    var dir = dirs[n],
      subdirs;
    try {
      subdirs = fs.readdirSync(dir);
    } catch (e) {
      // ignore invalid dirs
      continue;
    }

    for (var i in subdirs) {
      loadPackageAndRegister(path.join(dir, subdirs[i]), host);
    }
  }
}

function loadPackageAndRegister(dir, host) {
  var metadata;
  try {
    metadata = fs.readFileSync(path.join(dir, 'package.json'));
    metadata = JSON.parse(metadata);

    if (metadata.is_deepstream_plugin && metadata.name) {

      if (host.config && host.config.include) {
        if (host.config.include.indexOf(metadata.name) < 0) {
          return;
        }
      }
      if (host.config && host.config.exclude) {
        if (host.config.exclude.indexOf(metadata.name) >= 0) {
          return;
        }
      }

      try {
        let plugin = require(dir);
        if (plugin.registerPlugin) {
          let options;
          if (host.config.options && host.config.options[metadata.name]) {
            options = host.config.options[metadata.name];
          }
          plugin.registerPlugin(host.emitter, options);
        }
      } catch (e) {
        // ignore
      }
    }

  } catch (e) {
    // ignore invalid modules
  }
}
