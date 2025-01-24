const sentry = require('./shared/sentry');
const express = require('./shared/express');
const config = require('./shared/config');
const logging = require('@tryghost/logging');
const urlService = require('./server/services/url');

const fs = require('fs');
const path = require('path');

const isMaintenanceModeEnabled = (req) => {
    if (req.app.get('maintenance') || config.get('maintenance').enabled || !urlService.hasFinished()) {
        return true;
    }

    return false;
};

// We never want middleware functions to be anonymous
const maintenanceMiddleware = function maintenanceMiddleware(req, res, next) {
    if (!isMaintenanceModeEnabled(req)) {
        return next();
    }

    res.set({
        'Cache-Control': 'no-cache, private, no-store, must-revalidate, max-stale=0, post-check=0, pre-check=0'
    });
    res.writeHead(503, {'content-type': 'text/html'});
    fs.createReadStream(path.resolve(__dirname, './server/views/maintenance.html')).pipe(res);
};

// Used by Ghost (Pro) to ensure that requests cannot be served by the wrong site
const siteIdMiddleware = function siteIdMiddleware(req, res, next) {
    const configSiteId = config.get('hostSettings:siteId');
    const headerSiteId = req.headers['x-site-id'];

    if (`${configSiteId}` === `${headerSiteId}`) {
        return next();
    }

    logging.warn(`Mismatched site id (expected ${configSiteId}, got ${headerSiteId})`);

    res.set({
        'Cache-Control': 'no-cache, private, no-store, must-revalidate, max-stale=0, post-check=0, pre-check=0'
    });
    res.writeHead(500);
    res.end();
};

const rootApp = () => {
    const app = express('root');
    app.use(sentry.requestHandler);
    if (config.get('sentry')?.tracing?.enabled === true) {
        app.use(sentry.tracingHandler);
    }
    if (config.get('hostSettings:siteId')) {
        app.use(siteIdMiddleware);
    }
    app.enable('maintenance');
    app.use(maintenanceMiddleware);

    // Hacky middleware to force the same db connection to be used for the entire request
    app.use(async (req, res, next) => {
        const logging = require('@tryghost/logging');
        const asyncLocalStore = require('../../async-local-store');
        const knex = require('./server/data/db').knex;
        const reqId = require('uuid').v4();
        let connection = null;

        function releaseConnection() {
            if (connection) {
                // remove the __doNotRelease flag so the connection can be released
                // by the monkey patched releaseConnection
                delete connection.__doNotRelease;

                knex.client.releaseConnection(connection);

                connection = null;
            }
        }

        // Setup event listeners to release the connection when the response has been sent
        // or the request has been closed. The request will always be closed, but the response
        // may not finish if an error occurs during execution
        res.on('finish', releaseConnection);
        req.on('close', releaseConnection);

        // Retrieve a connection from the pool
        connection = await knex.client.acquireConnection();

        logging.debug(`[${reqId}] Acquired ${connection.__knexUid}`);

        // If the request has been aborted, release the connection immediately
        // and return early - This should not normally happen, but can if the
        // event loop is blocked and the request was aborted whilst waiting for
        // the connection to be acquired
        if (req.readableAborted) {
            releaseConnection();

            logging.debug(`[${reqId}] Request aborted whilst waiting for connection, releasing connection immediately`);

            return;
        }

        connection.__doNotRelease = true;

        // Execute the next middleware with an async context
        asyncLocalStore.run({connection, reqId}, next);
    });

    return app;
};

module.exports = rootApp;
