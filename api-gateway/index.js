const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret';

app.use(express.json());
app.use(express.static('public'));

// 1. Mock Login Endpoint (Generates the token)
app.post('/login', (req, res) => {
    // In production, you would check a database for a real username/password here
    const token = jwt.sign({ username: 'florin_admin' }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token });
});

// 2. JWT Verification Middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Extracts "Bearer <token>"

    if (!token) {
        return res.status(401).json({ error: 'Access Denied: No Token Provided' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Access Denied: Invalid Token' });
        }
        req.user = user;
        next(); // Token is valid, proceed to the next function
    });
};

// 3. Protect the Checkout Route
app.post('/api/orders/checkout', authenticateToken, (req, res) => {
    console.log(`[GATEWAY] Checkout initiated by authenticated user: ${req.user.username}`);
    fetch('http://order-service:8080/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body)
    })
    .then(response => response.json())
    .then(data => res.json(data))
    .catch(error => {
        console.error('Error forwarding to Java:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    });
});


app.listen(PORT, () => {
    console.log(`API Gateway running on port ${PORT}`);
});