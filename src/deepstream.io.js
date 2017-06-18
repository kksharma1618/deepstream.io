'use strict'

const MessageProcessor = require('./message/message-processor')
const MessageDistributor = require('./message/message-distributor')
const EventHandler = require('./event/event-handler')
const messageParser = require('./message/message-parser')
const messageBuilder = require('./message/message-builder')
const readMessage = require('./utils/read-message')
const fs = require('fs')
const path = require('path')
const util = require('util')
const utils = require('./utils/utils')
const defaultOptions = require('./default-options')
const configInitialiser = require('./config/config-initialiser')
const jsYamlLoader = require('./config/js-yaml-loader')
const RpcHandler = require('./rpc/rpc-handler')
const RecordHandler = require('./record/record-handler')
const PresenceHandler = require('./presence/presence-handler')
const DependencyInitialiser = require('./utils/dependency-initialiser')
const ClusterRegistry = require('./cluster/cluster-registry')
const UniqueRegistry = require('./cluster/cluster-unique-state-provider')
const C = require('./constants/constants')
const pkg = require('../package.json')
const PluginManager = require("./utils/pluginmanager");
const StateMachine = require('javascript-state-machine/dist/state-machine')

const EventEmitter = require('events').EventEmitter
const EOL = require('os').EOL

const STATES = C.STATES

/**
 * Deepstream is a realtime data server that scales horizontally
 * by running in clusters of interacting nodes
 *
 * @copyright 2016 deepstreamHub GmbH
 * @author deepstreamHub GmbH
 *
 * @param {Object} config Configuration object
 *
 * @constructor
 */
const Deepstream = function (config) {
  this.constants = C
  this._loadConfig(config)
  this._connectionEndpoint = null
  this._messageProcessor = null
  this._messageDistributor = null
  this._eventHandler = null
  this._rpcHandler = null
  this._recordHandler = null
  this._messageBuilder = messageBuilder

  const state = {
    init: STATES.STOPPED,
    transitions: [
      { name: 'start', from: STATES.STOPPED, to: STATES.LOGGER_INIT },
      { name: 'logger-started', from: STATES.LOGGER_INIT, to: STATES.PLUGIN_INIT },
      { name: 'plugins-started', from: STATES.PLUGIN_INIT, to: STATES.SERVICE_INIT },
      { name: 'services-started', from: STATES.SERVICE_INIT, to: STATES.CONNECTION_ENDPOINT_INIT },
      { name: 'connection-endpoints-started', from: STATES.CONNECTION_ENDPOINT_INIT, to: STATES.RUNNING },

      { name: 'stop', from: STATES.LOGGER_INIT, to: STATES.LOGGER_SHUTDOWN },
      { name: 'stop', from: STATES.PLUGIN_INIT, to: STATES.PLUGIN_SHUTDOWN },
      { name: 'stop', from: STATES.SERVICE_INIT, to: STATES.SERVICE_SHUTDOWN },
      { name: 'stop', from: STATES.CONNECTION_ENDPOINT_INIT, to: STATES.CONNECTION_ENDPOINT_SHUTDOWN },
      { name: 'stop', from: STATES.RUNNING, to: STATES.CONNECTION_ENDPOINT_SHUTDOWN },

      { name: 'connection-endpoints-closed', from: STATES.CONNECTION_ENDPOINT_SHUTDOWN, to: STATES.SERVICE_SHUTDOWN },
      { name: 'services-closed', from: STATES.SERVICE_SHUTDOWN, to: STATES.PLUGIN_SHUTDOWN },
      { name: 'plugins-closed', from: STATES.PLUGIN_SHUTDOWN, to: STATES.LOGGER_SHUTDOWN },
      { name: 'logger-closed', from: STATES.LOGGER_SHUTDOWN, to: STATES.STOPPED },
    ],
    methods: {
      onInvalidTransition: (transition, from, to) => {
        throw new Error(`Invalid state transition: ${JSON.stringify({ transition, from, to })}`)
      }
    }
  }
  this._state = new StateMachine(state)
  this._state.observe(this)
}

util.inherits(Deepstream, EventEmitter)

/**
 * Sets the name of the process
 *
 * @type {String}
 */
process.title = 'deepstream server'

/**
 * Expose constants to allow consumers to access them without
 * requiring a reference to a deepstream instance.
 *
 * @type {Object}
*/
Deepstream.constants = C


/**
 * Utility method to return a helper object to simplify permissions assertions
 *
 * @param  {object} message description
 * @return {object}         description
 */
Deepstream.readMessage = readMessage

/**
 * Set a deepstream option. For a list of all available options
 * please see default-options.
 *
 * @param {String} key   the name of the option
 * @param {Mixed} value  the value, e.g. a portnumber for ports or an instance of a logger class
 *
 * @public
 * @returns {void}
 */
Deepstream.prototype.set = function (key, value) {
  let optionName
  if (key === 'message') {
    optionName = 'messageConnector'
  } else {
    optionName = key
  }

  if (this._options[optionName] === undefined) {
    throw new Error(`Unknown option "${optionName}"`)
  }

  this._options[optionName] = value
  return this
}

/**
 * Returns true if the deepstream server is running, otherwise false
 *
 * @public
 * @returns {boolean}
 */
Deepstream.prototype.isRunning = function () {
  return this._state.is(STATES.RUNNING)
}

/**
 * Starts up deepstream. The startup process has three steps:
 *
 * - First of all initialise the logger and wait for it (ready event)
 * - Then initialise all other dependencies (cache connector, message connector, storage connector)
 * - Instantiate the messaging pipeline and record-, rpc- and event-handler
 * - Start WS server
 *
 * @public
 * @returns {void}
 */
Deepstream.prototype.start = function () {
  if (!this._state.is(STATES.STOPPED)) {
    throw new Error(`Server can only start after it stops successfully. Current state: ${this._state.state}`)
  }
  this._showStartLogo()
  // move plugin ctro inside state.start
  this.pluginManager = new PluginManager(this._options.pluginLoader);
  process.nextTick(() => this._state.start())
}

/**
 * Stops the server and closes all connections. The server can be started again,
 * but all clients have to reconnect. Will emit a 'stopped' event once done
 *
 * @public
 * @returns {void}
 */
Deepstream.prototype.stop = function () {
  if (this._state.is(STATES.STOPPED)) {
    throw new Error('The server is already stopped.')
  }

  process.nextTick(() => this._state.stop())
}

/**
 * Expose the message-parser's convertTyped method for use within plugins
 *
 * @param   {String} value A String starting with a type identifier (see C.TYPES)
 *
 * @public
 * @returns {JSValue} the converted value
 */
Deepstream.prototype.convertTyped = function(value) {
  return messageParser.convertTyped(value)
}

/**
 * Expose the message-builder's typed method for use within plugins
 *
 * @param   {JSValue} value A javascript value
 *
 * @public
 * @returns {String} A type-prefixed string
 */
Deepstream.prototype.toTyped = function (value) {
  return messageBuilder.typed(value)
}


/* ======================================================================= *
 * ========================== State Transitions ========================== *
 * ======================================================================= */

/**
 * Log state transitions for debugging.
 *
 * @private
 * @returns {void}
 */
Deepstream.prototype.onBeforeTransition = function (transition) {
  const logger = this._options.logger
  if (logger) {
    logger.log(
      C.LOG_LEVEL.DEBUG,
      C.EVENT.INFO,
      `State transition (${transition.transition}): ${transition.from} -> ${transition.to}`
    )
  }
}

/**
 * First stage in the Deepstream initialisation sequence. Initialises the logger.
 *
 * @private
 * @returns {void}
 */
Deepstream.prototype.onEnterLoggerInit = function () {
  const loggerInitialiser = new DependencyInitialiser(this, this._options, 'logger')
  loggerInitialiser.once('ready', () => {
    if (this._options.logger instanceof EventEmitter) {
      this._options.logger.on('error', this._onPluginError.bind(this, 'logger'))
    }
    this._state.loggerStarted()
  })
}

/**
 * Invoked once the logger is initialised. Initialises any built-in or custom Deepstream plugins.
 *
 * @private
 * @returns {void}
 */
Deepstream.prototype.onEnterPluginInit = function () {
  const infoLogger = message => this._options.logger.log(C.LOG_LEVEL.INFO, C.EVENT.INFO, message)

  infoLogger(`deepstream version: ${pkg.version}`)

  // otherwise (no configFile) deepstream was invoked by API
  if (this._configFile != null) {
    infoLogger(`configuration file loaded from ${this._configFile}`)
  }

  if (global.deepstreamLibDir) {
    infoLogger(`library directory set to: ${global.deepstreamLibDir}`)
  }

  this._options.pluginTypes.forEach((pluginType) => {
    const initialiser = new DependencyInitialiser(this, this._options, pluginType)
    initialiser.once('ready', () => {
      this._checkReady(pluginType, initialiser.getDependency())
    })
  })
}

/**
 * Called whenever a dependency emits a ready event. Once all dependencies are ready
 * deepstream moves to the init step.
 *
 * @private
 * @returns {void}
 */
Deepstream.prototype._checkReady = function (pluginType, plugin) {
  if (plugin instanceof EventEmitter) {
    plugin.on('error', this._onPluginError.bind(this, pluginType))
  }

  const allPluginsReady = this._options.pluginTypes.every(type => this._options[type].isReady)

  if (allPluginsReady && this._state.is(STATES.PLUGIN_INIT)) {
    this._state.pluginsStarted()
  }
}

/**
 * Invoked once all plugins are initialised. Instantiates the messaging pipeline and
 * the various handlers.
 *
 * @private
 * @returns {void}
 */
Deepstream.prototype.onEnterServiceInit = function () {
  // let plugin have access to config object once most of its loaded
  this.pluginManager.emitParallel("ds:config", this._options);

  this._messageProcessor = new MessageProcessor(this._options)
  this._messageDistributor = new MessageDistributor(this._options)

  this._options.clusterRegistry = new ClusterRegistry(this._options)
  this._options.uniqueRegistry = new UniqueRegistry(this._options, this._options.clusterRegistry)

  this._eventHandler = new EventHandler(this._options)
  this._messageDistributor.registerForTopic(
    C.TOPIC.EVENT,
    (socketWrapper, message) => {
      const data = utils.getSocketDataForPlugins(socketWrapper);
      data.message = message;
      data.skip = false;
      this.pluginManager.emitSerial("ds:event", data, () => {
        if (!data.skip) {
          this._eventHandler.handle(socketWrapper, data.message);
        }
      });
    }
  )

  this._rpcHandler = new RpcHandler(this._options)
  this._messageDistributor.registerForTopic(
    C.TOPIC.RPC,
    (socketWrapper, message) => {
      const data = utils.getSocketDataForPlugins(socketWrapper);
      data.message = message;
      data.skip = false;
      this.pluginManager.emitSerial("ds:rpc", data, () => {
        if (!data.skip) {
          this._rpcHandler.handle(socketWrapper, data.message);
        }
      });
    }
  )

  this._recordHandler = new RecordHandler(this._options)
  this._messageDistributor.registerForTopic(
    C.TOPIC.RECORD,
    (socketWrapper, message) => {
      const data = utils.getSocketDataForPlugins(socketWrapper);
      data.message = message;
      data.skip = false;
      this.pluginManager.emitSerial("ds:record", data, () => {
        if (!data.skip) {
          this._recordHandler.handle(socketWrapper, data.message);
        }
      });
    }
  )

  this._presenceHandler = new PresenceHandler(this._options)
  this._messageDistributor.registerForTopic(
    C.TOPIC.PRESENCE,
    (socketWrapper, message) => {
      const data = utils.getSocketDataForPlugins(socketWrapper);
      data.message = message;
      data.skip = false;
      this.pluginManager.emitSerial("ds:presence", data, () => {
        if (!data.skip) {
          this._presenceHandler.handle(socketWrapper, data.message);
        }
      });
    }
  )

  this._messageProcessor.onAuthenticatedMessage = (...args) => {
    this.pluginManager.emitSerial("ds:auth", args[0]);
    this._messageDistributor.distribute(...args);
  }

  if (this._options.permissionHandler.setRecordHandler) {
    this._options.permissionHandler.setRecordHandler(this._recordHandler)
  }

  process.nextTick(() => this._state.servicesStarted())
}

/**
 * Invoked once all dependencies and services are initialised.
 * The startup sequence will be complete once the connection endpoint is started and listening.
 *
 * @private
 * @returns {void}
 */
Deepstream.prototype.onEnterConnectionEndpointInit = function () {
  this._connectionEndpoint = this._options.connectionEndpoints[0]
  this._options.connectionEndpoint = this._connectionEndpoint
  const connectionEndpointInitializer = new DependencyInitialiser(
    this, this._options, 'connectionEndpoint')

  connectionEndpointInitializer.once('ready', () => this._state.connectionEndpointsStarted())

  this._connectionEndpoint.onMessages = this._messageProcessor.process.bind(this._messageProcessor)
  this._connectionEndpoint.on(
    'client-connected',
    this._presenceHandler.handleJoin.bind(this._presenceHandler)
  )
  this._connectionEndpoint.on(
    'client-disconnected',
    this._presenceHandler.handleLeave.bind(this._presenceHandler)
  )
}

/**
 * Initialization complete - Deepstream is up and running.
 *
 * @private
 * @returns {void}
 */
Deepstream.prototype.onEnterRunning = function () {
  this._options.logger.log(C.LOG_LEVEL.INFO, C.EVENT.INFO, 'Deepstream started')
  this.emit('started')
}

/**
 * Begin deepstream shutdown.
 * Closes the (perhaps partially initialised) connectionEndpoints.
 *
 * @private
 * @returns {void}
 */
Deepstream.prototype.onEnterConnectionEndpointShutdown = function () {
  const endpoints = [this._connectionEndpoint]

  endpoints.forEach((endpoint) => {
    process.nextTick(() => endpoint.close())
  })

  utils.combineEvents(endpoints, 'close', () => this._state.connectionEndpointsClosed())
}

/**
 * Shutdown the services.
 *
 * @private
 * @returns {void}
 */
Deepstream.prototype.onEnterServiceShutdown = function () {
  this._options.clusterRegistry.leaveCluster()

  process.nextTick(() => this._state.servicesClosed())
}

/**
 * Close any (perhaps partially initialised) plugins.
 *
 * @private
 * @returns {void}
 */
Deepstream.prototype.onEnterPluginShutdown = function () {
  const closeablePlugins = []
  this._options.pluginTypes.forEach((pluginType) => {
    const plugin = this._options[pluginType]
    if (typeof plugin.close === 'function') {
      process.nextTick(() => plugin.close())
      closeablePlugins.push(plugin)
    }
  })

  if (closeablePlugins.length > 0) {
    utils.combineEvents(closeablePlugins, 'close', () => this._state.pluginsClosed())
  } else {
    process.nextTick(() => this._state.pluginsClosed())
  }
}

/**
 * Close the (perhaps partially initialised) logger.
 *
 * @private
 * @returns {void}
 */
Deepstream.prototype.onEnterLoggerShutdown = function () {
  const logger = this._options.logger
  if (typeof logger.close === 'function') {
    process.nextTick(() => logger.close())
    logger.once('close', () => this._state.loggerClosed())
    return
  }
  process.nextTick(() => this._state.loggerClosed())
}

/**
 * Final stop state.
 * Deepstream can now be started again.
 *
 * @private
 * @returns {void}
 */
Deepstream.prototype.onEnterStopped = function () {
  this.emit('stopped')
}

/**
 * Synchronously loads a configuration file
 * Initialization of plugins and logger will be triggered by the
 * configInitialiser, but it should not block. Instead the ready events of
 * those plugins are handled through the DependencyInitialiser in this instance.
 *
 * @param {Object} config Configuration object
 * @private
 * @returns {void}
 */
Deepstream.prototype._loadConfig = function (config) {
  if (config === null || typeof config === 'string') {
    const result = jsYamlLoader.loadConfig(config)
    this._configFile = result.file
    this._options = result.config
  } else {
    const rawConfig = utils.merge(defaultOptions.get(), config)
    this._options = configInitialiser.initialise(rawConfig)
  }
}

/**
 * Shows a giant ASCII art logo which is absolutely crucial
 * for the proper functioning of the server
 *
 * @private
 * @returns {void}
 */
Deepstream.prototype._showStartLogo = function () {

  this.pluginManager.emitParallel('core:started');
  this.emit("pluginEmitter", this.pluginManager.getEmitter());

  if (this._options.showLogo !== true) {
    return
  }
  /* istanbul ignore next */
  let logo

  try {
    const nexeres = require('nexeres') // eslint-disable-line
    logo = nexeres.get('ascii-logo.txt').toString('ascii')
  } catch (e) {
    logo = fs.readFileSync(path.join(__dirname, '..', '/ascii-logo.txt'), 'utf8')
  }

  /* istanbul ignore next */
  process.stdout.write(logo + EOL)
  process.stdout.write(` =========================   starting   ==========================${EOL}`)
}

/**
 * Callback for plugin errors that occur at runtime. Errors during initialisation
 * are handled by the DependencyInitialiser
 *
 * @param   {String} pluginName
 * @param   {Error} error
 *
 * @private
 * @returns {void}
 */
Deepstream.prototype._onPluginError = function(pluginName, error) {
  const msg = `Error from ${pluginName} plugin: ${error.toString()}`
  this._options.logger.log(C.LOG_LEVEL.ERROR, C.EVENT.PLUGIN_ERROR, msg)
}

module.exports = Deepstream
