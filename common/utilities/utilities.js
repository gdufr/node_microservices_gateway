var Promise = require("bluebird"),
    pathsConfig = require(__dirname +'/../config/paths');

var path = Promise.promisifyAll(require('path')),
    glob = Promise.promisify(require('glob')),
    routesRootDirectory = pathsConfig.paths.routesDirectory,
    generalLogger = require('logging')().general,
    app_config_settings = require('application-configuration')().settings,
    services = require('services')();

// This is designed so we can add microservices without changes to the server.js file
exports.registerMicroservices = function (seneca) {

    var clientInfoSettings = app_config_settings.get('/microservicesClientInfo');
    // read the list of config files in the microservicesRootDirectory and set the clients
    Object.keys(clientInfoSettings).forEach( function(key) {
        if (clientInfoSettings.hasOwnProperty(key)){
            generalLogger.log.info('setting microservice with clientInfo', clientInfoSettings[key]);

            seneca.client({
                type: clientInfoSettings[key].type,
                port: clientInfoSettings[key].port,
                pin: clientInfoSettings[key].pin
            });
        }
    })
};

// This is designed so we can add routes without changes to the server.js file
exports.registerRoutes = function (server) {
    // read the list of js files in the routesRootDirectory and set the routes from them
    glob(path.resolve( routesRootDirectory, '**/*.js'))
        .each(function (file) {

            var requiredRoute = require(path.resolve(file));
            if (requiredRoute.route) {
                generalLogger.log.info('Setting route: ', requiredRoute.route);

                server.route(requiredRoute.route);
            } else {
                generalLogger.log.info('Found file ' + file + ' in ' + routesRootDirectory +
                    ' but it doesn\'t export a route');
            }
        })
        .catch(function (reason) {
            generalLogger.log.info('Error in setting routes: ', reason);
        });
};
