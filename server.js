const Promise = require('bluebird')
const Hapi = require('hapi')
const Chairo = require('chairo')
const Server = new Hapi.Server()

// promisifyAll is the Bluebird way to make node CommonJS libraries into Promises, does not work with all libraries
const path = Promise.promisifyAll(require('path'))
const inert = require('inert')
const Boom = require('boom')
    /** ***********************Custom Libraries*************************************/
const security = require('security')()

const logging = require('logging')()
const generalLogger = logging.general
const logTypes = logging.logTypes
const transactionLogger = logging.transaction // Transaction generalLogger: only requests/responses
const performanceLogger = logging.performance // Performance generalLogger: for performance metrics

    /** ***********************Config and helpers**************************/
const appConfig = require('application-configuration')()
const appSettings = appConfig.settings
const appConstants = appConfig.constants
const gatewayUtil = require(path.resolve('./common/utilities/utilities.js'))
const cache = require('cache')()

// Initialize the general generalLogger that can log all levels depending on configuration
// Configure the hapi bunyan plugin that injects the general bunyan generalLogger into req.log
let configBunyan = {
  register: require('hapi-bunyan'),
  options: {logger: generalLogger.log}
}

let configChairo = {
  register: Chairo
}

let plugins = [configBunyan, configChairo, inert]
let connection = {}
// Create HTTP connection
if (appSettings.get('/CONNECTION_MODE') === 'HTTP' || appSettings.get('/CONNECTION_MODE') === 'BOTH') {
  connection = {
    port: process.env.PORT || appSettings.get('/APP_PORT'),
    host: process.env.HOST || appSettings.get('/APP_HOST')
  }

  Server.connection(connection)
}

// Create HTTPS connection
if (appSettings.get('/CONNECTION_MODE') === 'HTTPS' || appSettings.get('/CONNECTION_MODE') === 'BOTH') {
  connection = {
    port: process.env.PORT || appSettings.get('/SSL/PORT'),
    host: process.env.HOST || appSettings.get('/APP_HOST'),
    tls: {
      key: process.env.SSL_KEY || appSettings.get('/SSL/KEY'),
      cert: process.env.SSL_CERT || appSettings.get('/SSL/CERT')
    }
  }
  Server.connection(connection)
}

const onRequest = function (req, reply) {
  global.transStart = new Date()
  reply.continue()
}

const onPreAuth = function onPreAuth (req, reply) {
    // all of the microservice configuration info is shared between the microservices and gateway via the application_configuration library
  const microservices = appSettings.get('/microservicesClientInfo')

    // the service is passed in the request to let the gateway know which microservice to route the request to
  const service = req.headers.service

    // the auth service handles login operations.
    // For any service that isn't Auth, the gateway expects to receive a web token (jwt) or to proceed anonymously
  if (service !== 'auth') {
        // pull the jwt out of the header
        // TODO: ask robin about the reason for this, looks like COOKIE_ENABLED is always false
    const jwt = appSettings.get('/JWT/COOKIE_ENABLED') ? security.jwt.getJwtCookie(req, {type: 'customer'}) : req.headers[appSettings.get('/JWT/COOKIE/NAME')]

        // some microservices can be accessed without the user being logged in, let them through here
    if (microservices[service].allowAnonymous) {
            // service is allowAnonymous
      if (jwt) {
                // isJwtValidAsync verifies that jwt was found in the redis cache
        security.jwt.isJwtValidAsync(jwt)
                    .then(function (res) {
                      if (res) {
                            // getJwtPayloadAsync decodes that customer jwt using the stored secret
                        return security.jwt.getJwtPayloadAsync(jwt, {type: 'customer'})
                                .then(payload => {
                                    // set the cachekey
                                  req.server.app.cacheKey = payload.customerId
                                    // fetchCacheResult retrieves the jwt userinfo from the cache
                                  return cache.fetchCacheResult(payload.customerId, 'userinfo')
                                })
                                .then(result => {
                                    // sets the returned userinfo object to the http request.headers object for passing to the microservice
                                  req.headers.userinfo = result
                                  reply.continue()
                                })
                                .catch(err => {
                                    // there was an error above, client wants us to return 400 level response codes on err
                                  generalLogger.log.error(logTypes.fnInside({err: err}), 'unable to retrieve JWT Token')
                                  return reply(Boom.unauthorized('Unable to retrieve JWT', 'sample'))
                                })
                      } else {
                            // the user session is not active
                        return reply(Boom.unauthorized('JWT Expired', 'sample'))
                      }
                    })
                    .catch((err) => {
                      console.log('jwt validation error:', err)
                      return reply().code(401)
                    })
      } else {
                // The service has allowAnonymous set to true and no jwt was passed
                // let it through to the microservice to handle
        reply.continue()
      }
    } else {
            // allowAnonymous = 0, don't let request through unless jwt is valid
      if (!jwt) return reply(Boom.unauthorized('missing JWT Cookie', 'sample'))

            // isJwtValidAsync verifies that jwt was found in the redis cache
      security.jwt.isJwtValidAsync(jwt)
                .then(function (res) {
                  if (res) {
                        // getJwtPayloadAsync decodes that customer jwt using the stored secret
                    return security.jwt.getJwtPayloadAsync(jwt, {type: 'customer'})
                            .then(function (payload) {
                              generalLogger.log.debug(logTypes.fnInside({}), 'fetch get JWT Async')
                                // set the cachekey
                              req.server.app.cacheKey = payload.customerId

                                // fetchCacheResult retrieves the jwt userinfo from the cache
                              return cache.fetchEsbResult(payload.customerId, 'userinfo')
                            })
                            .then(function (result) {
                              generalLogger.log.debug(logTypes.fnInside({}), 'fetch cached userinfo using customerId')
                                // check if user has a restricted scope in JWT and tries to access a restricted service
                              if (result.scope === 'restricted') return reply(Boom.unauthorized('restricted access', 'sample'))
                              req.headers.userinfo = result
                              reply.continue()
                            })
                            .catch(function () {
                              return reply(Boom.unauthorized('Unable to retrieve JWT', 'sample'))
                            })
                  } else {
                    return reply(Boom.unauthorized('JWT Expired', 'sample'))
                  }
                })
                .catch(function (err) {
                  console.log('jwt validation error:', err)
                  return reply().code(401)
                })
    }
  } else {
        // auth Service Call: inject sec04 cookie into header
    if (appSettings.get('/JWT/COOKIE_ENABLED')) req.headers[appSettings.get('/JWT/CMT/COOKIE/NAME')] = security.jwt.getJwtCookie(req, {type: 'cmt'})
    reply.continue()
  }
}

const onPreHandler = function onPreHandler (req, reply) {
    // Save the reqId (transactionId) to be used by the generalLogger in places where there is no reference to 'req'
  global.reqId = req.id
  reply.continue()
}

const onPreResponse = function onPreResponse (req, reply) {
  let response = req.response

    // set JWT Cookie for success oAuth JWT response
  if (appSettings.get('/JWT/COOKIE_ENABLED')) {
    if (req.headers.service === 'auth' && response.source[appSettings.get('/JWT/COOKIE/NAME')] && response.statusCode === 200) {
      const newResponse = reply()
            // Alter cookie expiration time depending on oAuthToken prescence
      security.jwt.setJwtCookie(
                response.source[appSettings.get('/JWT/COOKIE/NAME')],
                newResponse,
                req.payload.oAuthToken ? appSettings.get('/JWT/EXPIRATION') : appSettings.get('/JWT/CMT/COOKIE/EXPIRE_TIME')
            )
    }
  }

  let allowHeaders = appConstants.get('/ALLOW_HEADERS')

  if (response.header !== undefined) {
    response.header('Access-Control-Allow-Credentials', true)
    response.header('Access-Control-Allow-Headers', allowHeaders.join(', '))
    response.header('Access-Control-Allow-Methods', 'POST,GET,PUT,DELETE,OPTIONS')
    response.header('Access-Control-Expose-Headers', allowHeaders.join(', '))
    response.header('Access-Control-Allow-Origin', req.headers.origin)
  }

    // Send transactionId back to frontend in a header (this property is called req_id in our logs, but will be called transactionId
    // for the response header
  if (response.header !== undefined) {
    response.header('transactionId', req.id)
  }

  return reply.continue()
}

// hook the functions into the appropriate server hooks
Server.ext('onRequest', onRequest)
Server.ext('onPreAuth', onPreAuth)
Server.ext('onPreHandler', onPreHandler)
Server.ext('onPreResponse', onPreResponse)

// Configure sec02token cookie settings
Server.state(appSettings.get('/JWT/COOKIE/NAME'), {
  isSecure: appSettings.get('/JWT/COOKIE/isSecure'),
  isHttpOnly: appSettings.get('/JWT/COOKIE/isHttpOnly')
})

// HTTP Response logging:
// Instead of hooking into the hapi extension point, onPreResponse, we have to do logging here because when
// onPreResponse is called, the header values haven't been populated yet and we want to log those. Header
// values are populated on this general Node 'response' event so we do response logging here
// We are using a bunyan object to do the logging instead of the hapi-bunyan plugin because the plugin doesn't support
// two loggers
Server.on('response', function (data, tags) {
  let transEnd = new Date() // Get the end time of the transaction

  data.response.transactionTime = transEnd - global.transStart // Calculate the total transaction time
  transactionLogger.log.info(logTypes.res(data.response), 'Response back to client')
  performanceLogger.log.info(logTypes.res(data.response), 'Response back to client')
})

// register and export the server
Server.register(plugins, function (err) {
  if (err) {
    return err
  } else {
      console.log("Starting gateway server with settings: ", connection);

      Server.start(function (err) {
      if (err) {
        throw err
      } else {
        gatewayUtil.registerMicroservices(Server.seneca)
        gatewayUtil.registerRoutes(Server)
        cache.getRedisClient()
      }
    })
  }
})
module.exports = Server
