This is the gateway server for the Node Microservices boilerplate.

It will perform routing for the microservices using Seneca for orchestration.

It will also perform functions that must be performed on every request/response
    i.e. 
    Validate and decode the token with every request
    log the request and response for every request with the transaction logger
    etc
    
    Basic Structure:
    
        server.js initializes the server, sets up some logging/caching, pulls in configuration settings, etc
        
        routes/generalRouter/generalRouter.js has the routing functions
                
        app-config settings.js contains the settings for each microservice
            both the gateway and microservice get the settings from there
            i.e:
                    hello: {
                        type: 'tcp', // protocol
                        port: 3029, 
                        pin: 'service:hello', // pin is used to match a request to a microservice
                        allowAnonymous: 0, // determines if the gateway will route requests from anonymous users to the microservice
                        restricted: 0 // determines if the microservice will accept requests from users without a full access token
                    },
                    
                    
    Getting started:
    
        // clone the gateway
        // --depth 1 removes all but one .git commit history
        git clone --depth 1 git@github.com:5forcegees/node_microservices-gateway.git
        
        // change directory into the gateway
        cd node-gateway
    
    
        // install the node modules and support libraries
        npm install
        
        // start the application
        npm start
        
        
        // make a request
        Since there isn't a front end to this project you can use the included postman collection to make a request
        
        On *nix systems you can also use this curl
            curl -X GET \
              http://127.0.0.1:3010/ping \
              -H 'cache-control: no-cache' \
              -H 'service: hello'
        
        The gateway uses microservices to perform functions.  Check out these microservices to see it all working together:
        https://github.com/5forcegees/node_microservices-hackerNews
        https://github.com/5forcegees/node_microservices-hello
    
