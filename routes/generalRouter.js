const appConfig = require('application-configuration')()
const appSettings = appConfig.settings
const appConstants = appConfig.constants
const _ = require('lodash')
const async = require('async')
const microservicesClientInfo = appSettings.get('/microservicesClientInfo')
const logging = require('logging')()
const transactionLogger = logging.transaction
const performanceLogger = logging.performance
const generalLogger = logging.general
const logTypes = logging.logTypes

const errorHandler = function errorHandler(error, type = '/NODE_CODES/INTERNAL_NODE_ERROR') {
    let errorObj = new Error()
    const genericError = appConstants.get(type)

    if (error.response) return error

    errorObj.response = {}
    if (error.isBoom) {
        errorObj.response.errorCode = typeof (error.data) === 'object' ? error.data['ERROR_CODE'] : genericError['ERROR_CODE']
        errorObj.response.errorMessage = error.data.ERROR_DESCRIPTION
        errorObj.response.statusCode = error.output.statusCode
        if (error.data['QUESTION']) {
            errorObj.response.question = error.data['QUESTION']
        }
    } else if (error.ERROR_CODE && error.STATUS_CODE) {
        console.log(2)

        // we were passed a properly formatted error object, set up the response using those values
        errorObj.response.errorCode = error.ERROR_CODE
        errorObj.response.errorMessage = error.ERROR_DESCRIPTION
        errorObj.response.statusCode = parseInt(error.STATUS_CODE)
    } else {
        console.log(3)

        errorObj.response.errorCode = genericError['ERROR_CODE']
        errorObj.response.errorMessage = genericError['ERROR_DESCRIPTION']
        errorObj.response.statusCode = parseInt(genericError['STATUS_CODE'])
    }

    generalLogger.log.error(logTypes.fnInside({errorResponse: errorObj}), 'Error response body returned')

    console.log(4)
    return errorObj
}

function isSenecaTimeout(err) {
    // Looking at the err object to try and detect if it's a Seneca timeout issue.
    if (err && err.seneca && err.details && err.details.message && err.details.message.includes('[TIMEOUT]')) {
        generalLogger.log.debug(logTypes.fnInside(), `Seneca timeout detected`)
        return true
    } else {
        generalLogger.log.debug(logTypes.fnInside(), `Seneca timeout NOT detected`)
        return false
    }
}

// this route handles all of the direct microservice calls. It serves as an example of
// aggregating calls along variable paths, for example ->  path: '/apigateway/{service}'
exports.route = [
    {
        method: ['GET', 'POST', 'PUT', 'DELETE'],
        path: '/apigateway',
        config: {
            cors: true
        },
        handler: function (req, reply) {
            var service = req.headers.service
            var operation = req.headers.operation

            console.log('gateway got req: ', req);

            transactionLogger.log.info(logTypes.req(req, appConstants.get('/LOGGING/REQ_TYPE/API_CALL'), `API Gateway called: [${req.method}] method called on [${service}] service`))
            generalLogger.log.trace(logTypes.req("Gateway received request: ", req ))
            performanceLogger.log.info(logTypes.req(req, appConstants.get('/LOGGING/REQ_TYPE/API_CALL'), `API Gateway called: [${req.method}] method called on [${service}] service`))

            req.log.info(logTypes.fnEnter(), `API Gateway called: [${req.method}] method called on [${service}] service`)

            // only react to services defined in application_configuration microservicesClientInfo, otherwise send empty reply
            if (_.includes(Object.keys(microservicesClientInfo), service)) {
                const input = {
                    service: service,
                    operation: operation,
                    headers: req.headers,
                    body: req.payload,
                    query: req.query,
                    params: req.params,
                    method: req.method,
                    cacheKey: req.server.app.cacheKey,
                    reqId: req.id,
                    timeout$: appSettings.get('/SENECA_TIMEOUT') // real scenario testing is showing 60s actual
                }


                req.log.debug(logTypes.fnInside({input: input}), `Service: ${service} found with request inputs`)

                var timesTried = 0

                req.log.debug(logTypes.fnInside({timesTried: timesTried}), `Using async to send the request to microservice, ${service}`)
                // This forces Gateway to try to call the microservice x number of times in case the call times out
                // Only does a retry if it is a TIMEOUT, does NOT retry if any other error
                async.retry({
                        // async will try this x times as long as errorFilter returns true
                        times: appSettings.get('/GATEWAY_MAX_TRIES'),

                        // This is the condition that has to be met before it will retry
                        // If this returns true, then async wil retry again, otherwise it is a success and it won't retry
                        // Only retry for GET calls and not POST,PUT,DELETE
                        errorFilter: function (err) {
                            // We only retry on Seneca timeout errors and not other types of errors
                            if (isSenecaTimeout(err) && req.method === 'get') {
                                req.log.debug(logTypes.fnInside(), `Attempt ${timesTried} to call ${service} FAILED`)
                                return true
                            }
                        }
                    },

                    // This is the function that we want async to retry
                    function (cb) {
                        timesTried++
                        req.log.debug(logTypes.fnInside({timesTried: timesTried}), `Attempt ${timesTried} to call ${service}`)
                        req.seneca.act(input, cb)
                    },

                    // This gets called by the callback above (cb), handles the result/err from the microservice
                    function (err, result) {
                        req.log.debug(logTypes.fnInside({timesTried: timesTried}), `Attempt ${timesTried} received response/error signal from microservice, ${input.service}`)

                        // Most errors should be in err now, but also check result.err just in case
                        // Check 'result' first b/c if there is an unhandled exception, result is undefined
                        // also check for valid error object in the result
                        // TODO: structure error response from microservices consistently
                        if ((result && result.err) || err || (result.ERROR_CODE && result.STATUS_CODE)) {
                            let errorRes = errorHandler(err || result.err || result)

                            if (isSenecaTimeout(err || result.err)) {
                                req.log.error(logTypes.fnInside({err: err || result.err}), ` ******************   Attempt ${timesTried} resulted in error due to Seneca TIMEOUT`)
                                errorRes.response.statusCode = 503
                                errorRes.response.errorMessage = 'Time Out Error: Could not retrieve data from back end'
                                return reply(errorRes.response.errorMessage).code(errorRes.response.statusCode)
                            } else {
                                req.log.error(logTypes.fnInside({err: err || result.err}), `Attempt ${timesTried} received an error from microservice, ${input.service}`)
                            }

                            return reply(errorRes.response).code(errorRes.response.statusCode)
                        } else {
                            req.log.debug(logTypes.fnInside(), `Attempt ${timesTried} successful and received transformed JSON`)
                            req.log.info(logTypes.fnInside({result: result.result}), `Returning payload back in response`)
                            reply(result.result)
                        }
                        req.log.info(logTypes.fnExit(), `Exiting the API Gateway handler function`)
                    }
                )
            } else {
                req.log.info(logTypes.fnInside(), `Service: ${service} requested but not defined in microservicesClientInfo`)

                reply({
                    message: 'gateway router not configured to route to ' + service + ' service'
                })
            }
        }
    },
    {
        method: ['GET'],
        path: '/ping',
        config: {
            cors: true
        },
        handler: function (req, reply) {
            reply("pong")
        }
    }
]
