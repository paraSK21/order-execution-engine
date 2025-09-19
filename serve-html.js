const express = require('express');
const path = require('path');

const app = express();
const port = 8080;

// Serve static files from current directory
app.use(express.static('.'));

// Serve the HTML file at root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'websocket-test.html'));
});

app.listen(port, () => {
    console.log(`HTML server running on http://localhost:${port}`);
    console.log(`Open: http://localhost:${port}`);
});
