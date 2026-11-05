const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = 3000;

app.use(express.json());

// Proxy requests to the Java Order Service
app.use('/api/orders', createProxyMiddleware({ 
    target: 'http://localhost:8080', 
    changeOrigin: true 
}));

// Proxy requests to the Python AI Service
app.use('/api/ai', createProxyMiddleware({ 
    target: 'http://localhost:8000', 
    changeOrigin: true 
}));

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'API Gateway is actively routing' });
});

app.listen(PORT, () => {
    console.log(`API Gateway running on http://localhost:${PORT}`);
});