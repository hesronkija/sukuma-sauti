// Start file for hosting. cPanel's Node.js loader requires this file instead of
// running it, so the server has to start unconditionally here (app.js only
// starts on its own when run directly, which keeps the tests self-contained).
'use strict';
const { app } = require('./app.js');
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Sauti ya Kisukuma listening on ${port}`));
