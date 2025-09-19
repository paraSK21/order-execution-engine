import fastify from 'fastify';
import websocket from '@fastify/websocket';
import orderController from './controllers/orderController';
import * as dotenv from 'dotenv';

dotenv.config();

const app = fastify({ logger: true });

// Add CORS headers manually
app.addHook('onRequest', async (request, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (request.method === 'OPTIONS') {
    reply.status(200).send();
  }
});

app.register(websocket);
app.register(orderController);

// Serve the HTML file at root
app.get('/', async (request, reply) => {
    return reply.type('text/html').send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Order Execution Engine - WebSocket Test</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .container { max-width: 800px; margin: 0 auto; }
        .form-group { margin: 10px 0; }
        label { display: block; margin-bottom: 5px; }
        input, select { padding: 8px; width: 200px; }
        button { padding: 10px 20px; background: #007bff; color: white; border: none; cursor: pointer; }
        button:hover { background: #0056b3; }
        .status { margin: 20px 0; padding: 15px; border-radius: 5px; }
        .pending { background: #fff3cd; border: 1px solid #ffeaa7; }
        .routing { background: #d1ecf1; border: 1px solid #bee5eb; }
        .building { background: #d4edda; border: 1px solid #c3e6cb; }
        .submitted { background: #e2e3e5; border: 1px solid #d6d8db; }
        .confirmed { background: #d1edff; border: 1px solid #b8daff; }
        .failed { background: #f8d7da; border: 1px solid #f5c6cb; }
        .log { background: #f8f9fa; border: 1px solid #dee2e6; padding: 10px; height: 300px; overflow-y: auto; }
        .hidden { display: none; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 Order Execution Engine</h1>
        
        <div class="form-group">
            <label for="tokenIn">Token In:</label>
            <select id="tokenIn">
                <option value="SOL">SOL</option>
                <option value="USDC">USDC</option>
            </select>
        </div>
        
        <div class="form-group">
            <label for="tokenOut">Token Out:</label>
            <select id="tokenOut">
                <option value="USDC">USDC</option>
                <option value="SOL">SOL</option>
            </select>
        </div>
        
        <div class="form-group">
            <label for="amount">Amount:</label>
            <input type="number" id="amount" value="10" step="0.1">
        </div>
        
        <button onclick="submitOrder()">Submit Order</button>
        
        <div id="status" class="status hidden">
            <h3>Order Status</h3>
            <div id="statusContent"></div>
        </div>
        
        <div class="log">
            <h3>Live Updates</h3>
            <div id="log"></div>
        </div>
    </div>

    <script>
        let currentOrderId = null;
        let ws = null;

        // Auto-detect the API URL (works with localhost and ngrok)
        function getApiUrl() {
            // If running on ngrok, use the current domain
            if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
                return window.location.origin;
            }
            // Otherwise use localhost
            return 'http://localhost:3000';
        }

        async function submitOrder() {
            const tokenIn = document.getElementById('tokenIn').value;
            const tokenOut = document.getElementById('tokenOut').value;
            const amount = parseFloat(document.getElementById('amount').value);

            try {
                const apiUrl = getApiUrl();
                const response = await fetch(\`\${apiUrl}/api/orders/execute\`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        tokenIn,
                        tokenOut,
                        amount
                    })
                });

                if (!response.ok) {
                    const errorText = await response.text().catch(() => 'Unknown error');
                    throw new Error(\`HTTP \${response.status}: \${errorText}\`);
                }

                const data = await response.json();
                if (!data || !data.orderId) {
                    throw new Error('Server response missing orderId');
                }
                currentOrderId = data.orderId;
                
                log(\`✅ Order submitted: \${currentOrderId}\`);
                log(\`📋 Status: \${data.status}\`);
                
                // Show status div
                document.getElementById('status').style.display = 'block';
                try { updateStatus(data); } catch (e) { log(\`❌ Render error: \${e instanceof Error ? e.message : String(e)}\`); }
                
                // Connect to WebSocket
                connectWebSocket();
                
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                log(\`❌ Error: \${message}\`);
            }
        }

        function connectWebSocket() {
            if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
                ws.close();
            }

            if (!currentOrderId) {
                log('❌ No current order id to subscribe to');
                return;
            }

            const apiUrl = getApiUrl();
            const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
            const wsUrl = \`\${protocol}://\${apiUrl.replace(/^https?:\\/\\//, '')}/api/orders/\${encodeURIComponent(currentOrderId)}/status\`;
            ws = new WebSocket(wsUrl);
            
            ws.onopen = function() {
                log('🔌 WebSocket connected');
            };

            ws.onmessage = function(event) {
                let update;
                try {
                    update = JSON.parse(event.data);
                } catch (e) {
                    log('❌ Received non-JSON message');
                    return;
                }
                log(\`📡 Status Update: \${update.status}\`);
                
                if (update.selectedDex) {
                    log(\`🎯 Selected DEX: \${update.selectedDex}\`);
                }
                
                if (update.txHash) {
                    log(\`📄 Transaction: \${update.txHash}\`);
                }
                
                if (update.executedPrice) {
                    log(\`💰 Executed Price: \${update.executedPrice} \${update.tokenOut || 'USDC'}\`);
                }
                
                try { updateStatus(update); } catch (e) { log(\`❌ Render error: \${e instanceof Error ? e.message : String(e)}\`); }
                
                if (['confirmed', 'failed'].includes(update.status)) {
                    log('🎉 Order completed!');
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.close();
                    }
                }
            };

            ws.onerror = function(event) {
                const description = (event && event.message) || (event && event.type) || 'Unknown error';
                log(\`❌ WebSocket error: \${description}\`);
            };

            ws.onclose = function() {
                log('🔌 WebSocket disconnected');
            };
        }

        function updateStatus(data) {
            const statusDiv = document.getElementById('statusContent');
            const safe = (v) => (v === undefined || v === null ? '' : String(v));
            const selectedDexHtml = data.selectedDex ? '<p><strong>Selected DEX:</strong> ' + safe(data.selectedDex) + '</p>' : '';
            const txHashHtml = data.txHash ? '<p><strong>Transaction:</strong> ' + safe(data.txHash) + '</p>' : '';
            const executedPriceHtml = data.executedPrice ? '<p><strong>Executed Price:</strong> ' + safe(data.executedPrice) + ' ' + safe(data.tokenOut) + '</p>' : '';
            const statusClass = data.status ? safe(data.status) : '';
            const statusText = data.status ? safe(String(data.status).toUpperCase()) : '';
            statusDiv.innerHTML = \`
                <p><strong>Order ID:</strong> \${safe(data.orderId)}</p>
                <p><strong>Status:</strong> <span class="\${statusClass}">\${statusText}</span></p>
                <p><strong>Amount:</strong> \${safe(data.amount)} \${safe(data.tokenIn)} → \${safe(data.tokenOut)}</p>
                \${selectedDexHtml}
                \${txHashHtml}
                \${executedPriceHtml}
            \`;
        }

        function log(message) {
            const logDiv = document.getElementById('log');
            const timestamp = new Date().toLocaleTimeString();
            logDiv.insertAdjacentHTML('beforeend', \`<div>[\${timestamp}] \${message}</div>\`);
            logDiv.scrollTop = logDiv.scrollHeight;
        }
    </script>
</body>
</html>
    `);
});

const start = async () => {
  try {
    const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`Server running on http://localhost:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();