[deepstream.io](http://deepstream.io/) [![Build Status](https://travis-ci.org/deepstreamIO/deepstream.io.svg?branch=master)](https://travis-ci.org/deepstreamIO/deepstream.io) [![npm version](https://badge.fury.io/js/deepstream.io.svg)](http://badge.fury.io/js/deepstream.io) [![Coverage Status](https://coveralls.io/repos/github/deepstreamIO/deepstream.io/badge.svg?branch=master)](https://coveralls.io/github/deepstreamIO/deepstream.io?branch=master) [![dependencies Status](https://david-dm.org/deepstreamIO/deepstream.io/status.svg)](https://david-dm.org/deepstreamIO/deepstream.io) [![devDependencies Status](https://david-dm.org/deepstreamIO/deepstream.io/dev-status.svg)](https://david-dm.org/deepstreamIO/deepstream.io?type=dev)
==============================================
The Open Realtime Server
----------------------------------------------
deepstream is a new type of server that syncs data and sends events across millions of clients

## NOTE
This is a fork of deepstream.io. You are probably looking for the original deepstream at https://github.com/deepstreamIO/deepstream.io

### Goals of the fork
- To provide general purpose plugin support


### Usage

For now install using
```
npm install https://github.com/kksharma1618/deepstream.io.git#pluginsupport
```

Provide following options in your deepstream config.

```
pluginLoader: {
  enabled: false,
  pluginsDir: false,
  include: false,
  exclude: false,
  options: {
  }
}
```

*enabled*
Default is false. Plugin loader will only work when set to true.

*pluginsDir*
If provided then loader will look for plugins in only this folder.

Otherwise, it will look for plugins in:
- `node_prefix/lib/node_modules/*/package.json`
- `$HOME/.node_libraries/*/package.json`
- `$HOME/.node_modules/*/package.json`
- `require.main.paths/*/package.json`
- `require.main.paths[0]/package.json`

*include*
false | string[]
Names of plugins to load. Name of the plugin is taken from plugin's package.json "name" field. If you dont set this option, then loader will load all the valid plugins.

*exclude*
false | string[]
Names of plugins to exclude. Name of the plugin is taken from plugin's package.json "name" field. If you dont set this option, then loader will load all the valid plugins.

*options*
Provide options to plugins. key of this object will be the name of the plugin. value will passed as plugin options.
Eg:
```
pluginLoader: {
  options: {
    plugin1: {
      // option for plugin1
    },
    plugin2: {
      // option for plugin2
    }
  }
}
```

### What is a plugin
Plugin is an npm module that satisfies following criteria:
- package.json should have "is_deepstream_plugin" set to true
- package.json should have "name" field
- module should expose registerPlugin(emitter, options) function

Where emitter is https://github.com/bevry/event-emitter-grouped object.
And options is the plugin's option.

Deepstream host will use provided emitter object to trigger various hooks/filters.

Eg:
```
module.exports.registerPlugin = function(emitter, options) {
  emitter.on("core:started", function() {});
  emitter.on("ds:record", function(data, next) {});
  emitter.on("ds:event", function(data, next) {});
  emitter.on("ds:rpc", function(data, next) {});
}
```

data object is:
```
{
  user: socketWrapper.user,
  authData: socketWrapper.authData,
  uuid: socketWrapper.uuid,
  socket: socketWrapper,
  message: rpc|record|event,
  skip: false
}
```
In case of ds:rpc, ds:event, and ds:storage, you can cancel further processing by setting data.skip = true.

To see plugin support in action, check out https://github.com/kksharma1618/ds-plugin-validate
