const { inspect } = require('util');
const { DateTime } = require('luxon');
const { openRosaMessage } = require('../outbound/openrosa');
const { serialize } = require('../util/http');
const Problem = require('../util/problem');
const Option = require('../util/option');


// This helper is used by both endpoint and openrosaEndpoint to repeatedly
// resolve intermediate result products until a final result is achieved.
// The success and failure callbacks are appropriately called with the
// ultimate result thereof.
const finalize = (success, failure, request, response) => {
  const finalizer = (maybeResult) => {
    const result = Option.of(maybeResult).orElse(Problem.internal.emptyResponse());

    if (result.pipe != null) {
      // automatically stop a database query if the request is aborted:
      request.on('close', () => {
        if (typeof result.end === 'function')
          result.end();
      });
      return result.pipe(response);
    }

    if (result.isExplicitPromise === true)
      return result.point().then(finalizer, failure);

    if (result.then != null)
      return result.then(finalizer, failure);

    if (result.isProblem === true)
      return failure(result);

    success(result);
  };

  return finalizer;
};

// A simple endpoint wrapper to reduce significant boilerplate.
// Any service that uses this wrapper simply needs to return one of:
// * A Problem to be returned to the user, or
// * A FutureQuery that will be executed, after which the below applies:
// * A Promise that may resolve into either a serializable object on success,
//   or else a Problem to be returned to the user.
//   * If precisely null is returned, a 404 not found is returned to the user.
const endpoint = (f) => (request, response, next) => {
  const success = (result) => {
    if (!response.hasHeader('Content-Type')) response.type('json');
    response.status(200).send(serialize(result));
  };

  finalize(success, next, request, response)(f(request, response));
};

const openRosaEndpoint = (f) => (request, response, rawNext) => {
  const next = (x) => rawNext(((x != null) && (x.isProblem === true)) ? { forOpenRosa: x } : x, request, response);

  // Even if we fail we'll want these headers so just do it here.
  response.setHeader('Content-Language', 'en');
  response.setHeader('X-OpenRosa-Version', '1.0');
  response.setHeader('X-OpenRosa-Accept-Content-Length', '20' + '000' + '000'); // eslint-disable-line no-useless-concat
  response.setHeader('Date', DateTime.local().toHTTP());
  response.type('text/xml');

  // pedantry checks; reject if the protocol is not respected.
  const header = request.headers;
  if (header['x-openrosa-version'] !== '1.0')
    return next(Problem.user.invalidHeader({ field: 'X-OpenRosa-Version', value: header['x-openrosa-version'] }));
  // ODK Collect does not actually produce RFC 850/1123-compliant dates, so we munge the
  // date a little on its behalf:
  const patchedDate = (header.date == null) ? null : header.date.replace(/GMT.*$/i, 'GMT');
  if (DateTime.fromHTTP(patchedDate).isValid !== true)
    return next(Problem.user.invalidHeader({ field: 'Date', value: header.date }));

  // we assume any OpenRosa endpoint will only be passed xml strings.
  const success = (result) => { response.status(result.code).send(result.body); };
  finalize(success, next)(f(request, response));
};

// Given a error thrown upstream that is of our own internal format, this
// handler does the necessary work to translate that error into an HTTP error
// and send it out.
const sendError = (error, request, response) => {
  if (Object.prototype.hasOwnProperty.call(error, 'forOpenRosa')) {
    const problem = error.forOpenRosa;
    // TODO: include more of the error detail.
    response
      .status(problem.httpCode)
      .send(openRosaMessage(problem.code, { nature: 'error', message: problem.message }).body);
  } else if (error.isProblem === true) {
    // we already have a publicly-consumable error object.
    response.status(error.httpCode).type('application/json').send({
      message: error.message,
      code: error.problemCode,
      details: error.problemDetails
    });
  } else if (error.type === 'entity.parse.failed') {
    // catch body-parser middleware problems. we only ask it to parse JSOn, which
    // isn't part of OpenRosa, so we can assume a plain JSON response.
    sendError(Problem.user.unparseable({ format: 'json', rawLength: error.body.length }), request, response);
  } else {
    const details = {};
    if (error.stack != null)
      details.stack = error.stack.split('\n').map((x) => x.trim());

    debugger; // trip debugger if attached.
    process.stderr.write(inspect(error));
    response.status(500).type('application/json').send({
      message: `Completely unhandled exception: ${error.message}`,
      details
    });
  }
};


module.exports = { finalize, endpoint, openRosaEndpoint, sendError };
