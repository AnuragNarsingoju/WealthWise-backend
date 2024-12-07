const CryptoJS = require('crypto-js');
const express = require("express");
const axios = require('axios');
const mongoose = require('mongoose');
const {  Signup } = require("../models/allschemas");
const multer = require("multer");
const allroutes = express.Router();
const upload = multer();

const jwt = require('jsonwebtoken');
require('dotenv').config();
const admin = require('firebase-admin');


const base64Credentials = process.env.FIREBASE_CREDENTIALS_BASE64;
const credentials = JSON.parse(Buffer.from(base64Credentials, 'base64').toString('utf8'));
admin.initializeApp({
  credential: admin.credential.cert(credentials)
});

allroutes.post('/login', async (req, res) => {
  try {
        const encrypted1 = req.body.encrypted;
 
        if (!process.env.REACT_APP_SECRET || !process.env.TOKEN) {
            return res.status(500).json({ error: 'Server configuration error' });
        }
        const ps=process.env.REACT_APP_SECRET;
        const key = CryptoJS.enc.Utf8.parse(ps.padEnd(32, ' '));  
        const iv = CryptoJS.enc.Utf8.parse(ps.padEnd(16, ' ')); 
        
        let decrypted=""
        try {
            const bytes = CryptoJS.AES.decrypt(encrypted1, key, {
                iv: iv,
                mode: CryptoJS.mode.CBC,
                padding: CryptoJS.pad.Pkcs7
            });
            const decrypted1 = bytes.toString(CryptoJS.enc.Utf8);
            decrypted=JSON.parse(decrypted1);
           
        } catch (error) {
            console.error('Username or Password Incorrect', error.message);
        }
      
        const auth1 = decrypted.auth;
        const email = decrypted.email1;
        const recaptchatoken = decrypted.token1;
      
          if (!recaptchatoken) {
            return res.status(400).json({ error: 'Missing reCAPTCHA token' });
          }
    
        let firebaseEmail;
        try {
            const decodedToken = await admin.auth().verifyIdToken(auth1);
            const uid = decodedToken.uid;
            const userRecord = await admin.auth().getUser(uid);
            firebaseEmail = userRecord.email;
        } catch (authError) {
            return res.status(401).json({ error: 'Unauthorized1' });
        }

        if (firebaseEmail !== decrypted.email1) {
            return res.status(401).json({ error: 'Unauthorized2' });
        }

         try {
          const response = await axios.post(
            'https://www.google.com/recaptcha/api/siteverify',
            null,
            {
              params: {
                secret: process.env.SecretCaptcha,
                response: recaptchatoken,
              },
            }
          );

           const { success, score, action } = response.data;
    
          if (success || score >= 0.5) {
            const token = jwt.sign({ "email": email }, process.env.TOKEN, { expiresIn: '8h' });
            res.json({ token });

          } else {
            return res.status(400).json({ error: "Invalid captcha" });
          }
        } catch (error) {
          return res.status(500).json({ error: "Error verifying captcha" });
        }

    
    } catch (error) {
        return res.status(500).json({ error: 'Internal server error' });
    }
});

allroutes.post('/signup', async (req, res) => {
  const data = req.body;
  try {
    const newUser = await Signup.create(data);
    return res.status(201).json({ message: 'Signup successful', user: newUser });
  } catch (e) {
    console.error(e); 
    return res.status(400).json({ error: e.message });
  }
});



allroutes.get('/findemail', async (req, res) => {
  const { email } = req.query;

  try {
    const newUser = await Signup.findOne({ email: email });
    if (!newUser) {
      return res.status(404).json({ message: 'No user found with this email' });
    }
    return res.status(200).json({ message: 'User found', user: newUser });
  } catch (e) {
    console.error(e); 
    return res.status(400).json({ error: e.message });
  }
});



module.exports = allroutes;
