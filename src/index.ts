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
        body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
        .container { max-width: 1400px; margin: 0 auto; }
        .header { background: white; padding: 20px; border-radius: 10px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .form-section { display: flex; gap: 20px; align-items: end; flex-wrap: wrap; }
        .form-group { margin: 10px 0; }
        label { display: block; margin-bottom: 5px; font-weight: bold; }
        input, select { padding: 8px; width: 150px; border: 1px solid #ddd; border-radius: 4px; }
        button { padding: 10px 20px; background: #007bff; color: white; border: none; cursor: pointer; border-radius: 4px; }
        button:hover { background: #0056b3; }
        button:disabled { background: #6c757d; cursor: not-allowed; }
        .dashboard { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-top: 20px; }
        .order-card { background: white; border-radius: 10px; padding: 15px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .order-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .order-id { font-family: monospace; font-size: 12px; color: #666; }
        .status { padding: 8px 12px; border-radius: 20px; font-size: 12px; font-weight: bold; text-transform: uppercase; }
        .pending { background: #fff3cd; color: #856404; }
        .routing { background: #d1ecf1; color: #0c5460; }
        .building { background: #d4edda; color: #155724; }
        .submitted { background: #e2e3e5; color: #383d41; }
        .confirmed { background: #d1edff; color: #004085; }
        .failed { background: #f8d7da; color: #721c24; }
        .order-details { margin: 10px 0; }
        .order-details p { margin: 5px 0; font-size: 14px; }
        .order-details strong { color: #333; }
        .log { background: #f8f9fa; border: 1px solid #dee2e6; padding: 10px; height: 200px; overflow-y: auto; font-size: 12px; }
        .log-entry { margin: 2px 0; padding: 2px 0; }
        .timestamp { color: #666; font-size: 11px; }
        .controls { display: flex; gap: 10px; margin-bottom: 20px; }
        .stats { background: white; padding: 15px; border-radius: 10px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; }
        .stat-item { text-align: center; }
        .stat-number { font-size: 24px; font-weight: bold; color: #007bff; }
        .stat-label { font-size: 12px; color: #666; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 Order Execution Engine - Multi-Order Dashboard</h1>
            <p>Submit multiple orders to see concurrent processing in action!</p>
        </div>

        <div class="stats">
            <div class="stats-grid">
                <div class="stat-item">
                    <div class="stat-number" id="totalOrders">0</div>
                    <div class="stat-label">Total Orders</div>
                </div>
                <div class="stat-item">
                    <div class="stat-number" id="activeOrders">0</div>
                    <div class="stat-label">Active Orders</div>
                </div>
                <div class="stat-item">
                    <div class="stat-number" id="completedOrders">0</div>
                    <div class="stat-label">Completed</div>
                </div>
                <div class="stat-item">
                    <div class="stat-number" id="failedOrders">0</div>
                    <div class="stat-label">Failed</div>
                </div>
            </div>
        </div>

        <div class="header">
            <h3>📝 Submit New Order</h3>
            <div class="form-section">
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
                
                <div class="form-group">
                    <button onclick="submitOrder()">Submit Order</button>
                </div>
            </div>
        </div>

        <div class="controls">
            <button onclick="submitMultipleOrders()">Submit 5 Orders Quickly</button>
            <button onclick="clearCompleted()">Clear Completed</button>
            <button onclick="clearAll()">Clear All</button>
        </div>

        <div id="dashboard" class="dashboard">
            <!-- Order cards will be dynamically added here -->
        </div>
    </div>

    <script>
        // Global state for managing multiple orders
        const orders = new Map(); // orderId -> order data
        const websockets = new Map(); // orderId -> websocket connection
        let orderCounter = 0;

        // Auto-detect the API URL (works with localhost and ngrok)
        function getApiUrl() {
            if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
                return window.location.origin;
            }
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

                // Add order to tracking
                addOrder(data.orderId, {
                    orderId: data.orderId,
                    tokenIn,
                    tokenOut,
                    amount,
                    status: data.status,
                    timestamp: new Date().toISOString()
                });

                // Connect WebSocket for this order
                connectWebSocket(data.orderId);
                
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.error('Order submission failed:', message);
                alert(\`Failed to submit order: \${message}\`);
            }
        }

        async function submitMultipleOrders() {
            const orders = [
                { tokenIn: 'SOL', tokenOut: 'USDC', amount: 10 },
                { tokenIn: 'USDC', tokenOut: 'SOL', amount: 100 },
                { tokenIn: 'SOL', tokenOut: 'USDC', amount: 5 },
                { tokenIn: 'USDC', tokenOut: 'SOL', amount: 50 },
                { tokenIn: 'SOL', tokenOut: 'USDC', amount: 15 }
            ];

            console.log('🚀 Submitting 5 orders quickly to demonstrate concurrency...');
            
            for (const order of orders) {
                try {
                    const apiUrl = getApiUrl();
                    const response = await fetch(\`\${apiUrl}/api/orders/execute\`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(order)
                    });

                    if (response.ok) {
                        const data = await response.json();
                        addOrder(data.orderId, {
                            orderId: data.orderId,
                            ...order,
                            status: data.status,
                            timestamp: new Date().toISOString()
                        });
                        connectWebSocket(data.orderId);
                    }
                } catch (error) {
                    console.error('Failed to submit order:', error);
                }
                
                // Small delay between submissions
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        function addOrder(orderId, orderData) {
            orders.set(orderId, orderData);
            createOrderCard(orderId, orderData);
            updateStats();
        }

        function createOrderCard(orderId, orderData) {
            const dashboard = document.getElementById('dashboard');
            const orderNumber = ++orderCounter;
            
            const card = document.createElement('div');
            card.className = 'order-card';
            card.id = \`order-\${orderId}\`;
            
            card.innerHTML = \`
                <div class="order-header">
                    <div>
                        <strong>Order #\${orderNumber}</strong>
                        <div class="order-id">\${orderId.substring(0, 8)}...</div>
                    </div>
                    <div class="status \${orderData.status}">\${orderData.status}</div>
                </div>
                <div class="order-details">
                    <p><strong>Amount:</strong> \${orderData.amount} \${orderData.tokenIn} → \${orderData.tokenOut}</p>
                    <p><strong>Status:</strong> \${orderData.status}</p>
                    <div id="details-\${orderId}"></div>
                </div>
                <div class="log" id="log-\${orderId}">
                    <div class="log-entry">
                        <span class="timestamp">\${new Date().toLocaleTimeString()}</span> 
                        Order submitted
                    </div>
                </div>
            \`;
            
            dashboard.appendChild(card);
        }

        function connectWebSocket(orderId) {
            // Close existing WebSocket for this order if any
            if (websockets.has(orderId)) {
                websockets.get(orderId).close();
            }

            const apiUrl = getApiUrl();
            const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
            const wsUrl = \`\${protocol}://\${apiUrl.replace(/^https?:\\/\\//, '')}/api/orders/\${encodeURIComponent(orderId)}/status\`;
            
            const ws = new WebSocket(wsUrl);
            websockets.set(orderId, ws);
            
            ws.onopen = function() {
                logToOrder(orderId, '🔌 WebSocket connected');
            };

            ws.onmessage = function(event) {
                let update;
                try {
                    update = JSON.parse(event.data);
                } catch (e) {
                    logToOrder(orderId, '❌ Received non-JSON message');
                    return;
                }

                // Update order data
                const orderData = orders.get(orderId);
                if (orderData) {
                    Object.assign(orderData, update);
                    orders.set(orderId, orderData);
                    updateOrderCard(orderId, orderData);
                    updateStats();
                }

                // Log status changes
                if (update.status) {
                    logToOrder(orderId, \`📡 Status: \${update.status}\`);
                }
                
                if (update.selectedDex) {
                    logToOrder(orderId, \`🎯 Selected DEX: \${update.selectedDex}\`);
                }
                
                if (update.txHash) {
                    logToOrder(orderId, \`📄 Transaction: \${update.txHash}\`);
                }
                
                if (update.executedPrice) {
                    logToOrder(orderId, \`💰 Executed Price: \${update.executedPrice} \${update.tokenOut || 'USDC'}\`);
                }
                
                if (['confirmed', 'failed'].includes(update.status)) {
                    logToOrder(orderId, '🎉 Order completed!');
                    // Keep WebSocket open for a bit to ensure final message is received
                    setTimeout(() => {
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.close();
                        }
                    }, 2000);
                }
            };

            ws.onerror = function(event) {
                const description = (event && event.message) || (event && event.type) || 'Unknown error';
                logToOrder(orderId, \`❌ WebSocket error: \${description}\`);
            };

            ws.onclose = function() {
                logToOrder(orderId, '🔌 WebSocket disconnected');
                websockets.delete(orderId);
            };
        }

        function updateOrderCard(orderId, orderData) {
            const card = document.getElementById(\`order-\${orderId}\`);
            if (!card) return;

            // Update status badge
            const statusBadge = card.querySelector('.status');
            statusBadge.className = \`status \${orderData.status}\`;
            statusBadge.textContent = orderData.status;

            // Update details
            const detailsDiv = card.querySelector(\`#details-\${orderId}\`);
            let detailsHtml = '';
            
            if (orderData.selectedDex) {
                detailsHtml += \`<p><strong>Selected DEX:</strong> \${orderData.selectedDex}</p>\`;
            }
            if (orderData.txHash) {
                detailsHtml += \`<p><strong>Transaction:</strong> \${orderData.txHash}</p>\`;
            }
            if (orderData.executedPrice) {
                detailsHtml += \`<p><strong>Executed Price:</strong> \${orderData.executedPrice} \${orderData.tokenOut}</p>\`;
            }
            
            detailsDiv.innerHTML = detailsHtml;
        }

        function logToOrder(orderId, message) {
            const logDiv = document.getElementById(\`log-\${orderId}\`);
            if (!logDiv) return;

            const timestamp = new Date().toLocaleTimeString();
            const logEntry = document.createElement('div');
            logEntry.className = 'log-entry';
            logEntry.innerHTML = \`<span class="timestamp">\${timestamp}</span> \${message}\`;
            
            logDiv.appendChild(logEntry);
            logDiv.scrollTop = logDiv.scrollHeight;
        }

        function updateStats() {
            const total = orders.size;
            const active = Array.from(orders.values()).filter(o => !['confirmed', 'failed'].includes(o.status)).length;
            const completed = Array.from(orders.values()).filter(o => o.status === 'confirmed').length;
            const failed = Array.from(orders.values()).filter(o => o.status === 'failed').length;

            document.getElementById('totalOrders').textContent = total;
            document.getElementById('activeOrders').textContent = active;
            document.getElementById('completedOrders').textContent = completed;
            document.getElementById('failedOrders').textContent = failed;
        }

        function clearCompleted() {
            const completedOrderIds = Array.from(orders.entries())
                .filter(([id, order]) => ['confirmed', 'failed'].includes(order.status))
                .map(([id]) => id);

            completedOrderIds.forEach(orderId => {
                // Close WebSocket
                if (websockets.has(orderId)) {
                    websockets.get(orderId).close();
                }
                
                // Remove from tracking
                orders.delete(orderId);
                
                // Remove card from DOM
                const card = document.getElementById(\`order-\${orderId}\`);
                if (card) {
                    card.remove();
                }
            });

            updateStats();
        }

        function clearAll() {
            // Close all WebSockets
            websockets.forEach(ws => ws.close());
            websockets.clear();
            
            // Clear all orders
            orders.clear();
            
            // Clear dashboard
            document.getElementById('dashboard').innerHTML = '';
            
            // Reset counter
            orderCounter = 0;
            
            updateStats();
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