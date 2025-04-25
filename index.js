const express = require('express');
const app = express();
const allroutes = require('./routes/AllRoutes');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
dotenv.config();
app.use(express.json());
const jwt = require('jsonwebtoken');
const CryptoJS = require('crypto-js');

const corsOptions = {
    origin: ['https://wealthwisee.vercel.app','https://wealthwisee.live','https://www.wealthwisee.live'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Cookie']
};

app.use(cors(corsOptions));

const validateOrigin = (req, res, next) => {
    const allowedOrigins = ['https://wealthwisee.vercel.app','https://wealthwisee.live','https://www.wealthwisee.live'];
    if (!allowedOrigins.includes(req.headers.origin)) {
        return res.status(403).json({ error: 'Unauthorized request' });
    }
    next();
};

const authenticateToken = (req, res, next) => {
    if (req.path === '/api/login' || req.path === '/api/findmail' || req.path === '/api/signup' || req.path === '/api/nifty'  ) {
        return next();
    }
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).send('Token required');

    jwt.verify(token,process.env.TOKEN, (err, user) => {
        if (err) return res.status(403).send('Invalid token');
        req.user = user;
        next();
    });
};


app.use(validateOrigin);
app.use(authenticateToken);


const db = async () => {
    try {
        await mongoose.connect(process.env.DBURI);
    } catch (err) {
        console.log('Error connecting to database');
    }
};
db();

app.use('/api', allroutes);

app.listen(5001, () => {
    console.log('Backend server listening at port 5001');
});
