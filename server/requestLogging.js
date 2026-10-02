// Only application-owned route templates and numeric status codes reach logs.
// Never log bodies, headers, filenames, paths, query strings, tokens, or errors.
export function logRequest(req, res, next) {
    res.on('finish', () => {
        const method = ['GET', 'POST', 'HEAD', 'OPTIONS'].includes(req.method) ? req.method : 'OTHER';
        console.log('Request completed', {
            method,
            route: req.route?.path || 'unmatched',
            status: res.statusCode
        });
    });
    next();
}
