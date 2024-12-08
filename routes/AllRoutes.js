const CryptoJS = require('crypto-js');
const express = require("express");
const axios = require('axios');
const mongoose = require('mongoose');
const {  Signup , UserData } = require("../models/allschemas");
const multer = require("multer");
const allroutes = express.Router();
const upload = multer();


// chatbot 
const { Pinecone } = require('@pinecone-database/pinecone');
const { PineconeStore } = require("@langchain/pinecone");
const { PineconeEmbeddings } = require("@langchain/pinecone");
const { ChatGroq } = require("@langchain/groq");
const { PromptTemplate } = require("@langchain/core/prompts");
const { StringOutputParser } = require("@langchain/core/output_parsers");
async function chat(Question) {
  console.log(Question)
  try {
    const llm = new ChatGroq({
      model: "llama3-8b-8192",
      temperature: 0,
      maxTokens: undefined,
      maxRetries: 5,
    });

    const PINECONE_INDEX = "knowledge-retrival";
    const pinecone = new Pinecone();
    const pineconeIndex = pinecone.Index(PINECONE_INDEX);

    const embeddings = new PineconeEmbeddings({
      model: "multilingual-e5-large",
    });

    const vectorStore = await PineconeStore.fromExistingIndex(embeddings, {
      pineconeIndex,
      maxConcurrency: 5,
    });

    const retriever = vectorStore.asRetriever();

    const generateQueries = async (question) => {
      try {
        const prompt = PromptTemplate.fromTemplate(
          `You are a helpful assistant that generates exactly three distinct and concise questions related to an input question.
          The goal is to break the input question into three self-contained queries that can be answered independently. Ensure that:
          1. Each query is a complete question.
          2. No additional explanation or context is included.
    
          Input Question: {question}
          Generated Queries:
          1.
          2.
          3.`
        );

        const formattedPrompt = await prompt.format({ question });
        const response = await llm.invoke(formattedPrompt);

        const outputParser = new StringOutputParser();
        const parsedOutput = await outputParser.parse(response);
        const queries = parsedOutput.content.match(/^\d+\.\s.*?\?$/gm);

        return queries || [];
      } catch (error) {
        console.error("Error generating queries:", error);
        return [];
      }
    };

    const retrieveDocuments = async (subQuestions) => {
      try {
        const results = await Promise.all(
          subQuestions.map((q) => retriever.invoke(q))
        );
        return results;
      } catch (error) {
        console.error("Error retrieving documents:", error);
        return [];
      }
    };

    const reciprocalRankFusion = async (results, k = 60) => {
      try {
        const fusedScores = new Map();

        results.forEach((docs) => {
          docs.forEach((doc, rank) => {
            const docStr = JSON.stringify(doc);
            if (!fusedScores.has(docStr)) {
              fusedScores.set(docStr, 0);
            }
            fusedScores.set(
              docStr,
              fusedScores.get(docStr) + 1 / (rank + k)
            );
          });
        });

        return Array.from(fusedScores.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([docStr]) => JSON.parse(docStr));
      } catch (error) {
        console.error("Error in reciprocal rank fusion:", error);
        return [];
      }
    };

    const subQuestions = await generateQueries();

    const allDocuments = await retrieveDocuments(subQuestions);

    const topDocuments = await reciprocalRankFusion(allDocuments);

    const template = PromptTemplate.fromTemplate(
      `Please provide a comprehensive answer to the question below from below context by following these guidelines:
      Question: {question}

      Definition: Begin by clearly defining the term or concept referenced in the question.
      Real-Life Examples: Illustrate your explanation with examples of real-life individuals who exemplify this concept, to enhance understanding.
      Personal Finance Calculations: If the question involves personal finance and requires calculations, please compute any relevant values and present them.
      Irrelevant Questions: If the question does not pertain to personal finance, simply respond with: 'As an AI, I cannot provide information on that topic.'

      Context: {context}`
    );

    const finalPrompt = await template.format({
      question: Question,
      context: JSON.stringify(topDocuments, null, 2), // Ensure proper formatting
    });

    const outputParser = new StringOutputParser();
    const finalOutput = await outputParser.parse(await llm.invoke(finalPrompt));

    return finalOutput.content;
  } catch (error) {
    console.error("Error in chat function:", error);
    return "An error occurred while processing your request.";
  }
}


// chatbot End




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
  data.count=0;
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


allroutes.post("/updatecount", async (req, res) => {
  const { email } = req.body; 
  try {
    const updatedUser = await Signup.findOneAndUpdate(
      { email: email }, 
      { $set: { count: 1 } }, 
      { new: true, upsert: false } 
    );
    if (!updatedUser) {
      return res.status(404).json({ error: "User not found" });
    }
    return res.status(200).json({ message: "Count updated successfully", user: updatedUser });
  } catch (e) {
    console.error(e);
    return res.status(400).json({ error: e.message });
  }
});


allroutes.post('/submitdata', async (req, res) => {
  const formData = req.body.formData;
  try {
    if (!formData.email || !formData.income || !formData.age || !formData.city) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const existingData = await UserData.findOne({ email: formData.email });

    if (existingData) {
      existingData.income = formData.income;
      existingData.age = formData.age;
      existingData.city = formData.city;
      existingData.foodAtHome = formData.foodAtHome;
      existingData.foodAwayFromHome = formData.foodAwayFromHome;
      existingData.housing = formData.housing;
      existingData.transportation = formData.transportation;
      existingData.healthcare = formData.healthcare;
      existingData.education = formData.education;
      existingData.entertainment = formData.entertainment;
      existingData.personalCare = formData.personalCare;
      existingData.apparelAndServices = formData.apparelAndServices;
      existingData.tobaccoProducts = formData.tobaccoProducts;
      existingData.cashContributions = formData.cashContributions;
      existingData.alcoholicBeverages = formData.alcoholicBeverages;
      existingData.savings = formData.savings;
      await existingData.save();
      return res.status(200).json({ message: 'Data updated successfully', data: existingData });
    } else {
      const newData = new UserData({
        email: formData.email,
        income: formData.income,
        age: formData.age,
        city: formData.city,
        foodAtHome: formData.foodAtHome,
        foodAwayFromHome: formData.foodAwayFromHome,
        housing: formData.housing,
        transportation: formData.transportation,
        healthcare: formData.healthcare,
        education: formData.education,
        entertainment: formData.entertainment,
        personalCare: formData.personalCare,
        apparelAndServices: formData.apparelAndServices,
        tobaccoProducts: formData.tobaccoProducts,
        cashContributions: formData.cashContributions,
        alcoholicBeverages: formData.alcoholicBeverages,
        savings: formData.savings
      });
      await newData.save();
      return res.status(201).json({ message: 'Data saved successfully', data: newData });
    }
  } catch (error) {
    console.error('Error saving or updating data:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

allroutes.post('/chatbot4', async (req, res) => {
  const { question } = req.body;
  try {
    const answer = await chat(question);
    console.log(answer);
    res.status(200).json({ answer });

  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});


module.exports = allroutes;
