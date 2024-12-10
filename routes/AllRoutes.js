
const CryptoJS = require('crypto-js');
const express = require("express");
const axios = require('axios');
const mongoose = require('mongoose');
const {  Signup,UserData, csvFile } = require("../models/allschemas");
const multer = require("multer");
const allroutes = express.Router();
const csvtojson = require('csvtojson');
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const Groq = require("groq-sdk");
const bodyParser = require('body-parser');
require('dotenv').config();
const { Readable } = require("stream");
const upload = multer({ storage: multer.memoryStorage() });

// chatbot 
const { Pinecone } = require('@pinecone-database/pinecone');
const { PineconeStore } = require("@langchain/pinecone");
const { PineconeEmbeddings } = require("@langchain/pinecone");
const { ChatGroq } = require("@langchain/groq");
const { PromptTemplate } = require("@langchain/core/prompts");
const { StringOutputParser } = require("@langchain/core/output_parsers");

let retriever=null;
async function get_retriever() {
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
    retriever = vectorStore.asRetriever();
}
get_retriever();

async function chat(Question) {
  try {
    const llm = new ChatGroq({
      model: "llama3-8b-8192",
      temperature: 0,
      maxTokens: undefined,
      maxRetries: 5,
    });
    
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

        const formattedPrompt = await prompt.format({ question: Question });
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
    //console.log(topDocuments)

    const template = PromptTemplate.fromTemplate(
      `you are an financial advisory helper which understands the provided context below and give a beautiful understandable respones to the user by following the below guidlines:
        If the question is related to finance, provide a comprehensive answer that include:
        1.⁠ ⁠A definition 
        2.⁠ ⁠Real-life examples
        3.⁠ ⁠Personal finance calculations
        
        give responses based on the question . you may include or exclude above points based on the question. if the question doesn't require these points then reply using below context and also remember do all calculations in indian ruppess
        If the question does NOT relate to finance or personal finance, respond ONLY with: 'As an AI Chatbot, I cannot provide information on that topic.'
        
        Question: {question}
        Context: {context}
        `
    );

    const finalPrompt = await template.format({
      question: Question,
      context: topDocuments
    });
    //console.log(finalPrompt)
    const outputParser = new StringOutputParser();
    const finalOutput = await outputParser.parse(await llm.invoke(finalPrompt));
    return finalOutput.content;
  } catch (error) {
    console.error("Error in chat function:", error);
    return "An error occurred while processing your request.";
  }
}

//chat bot end

//fd start

const groq = new Groq({ apiKey: "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"});

let datasets = {
  taxSavingFd: [],
  seniorPublicFd: [],
  seniorPrivateFd: [],
  comparisonPublicFd: [],
  comparisonPrivateFd: [],
};

function calculateMaturity(principal, rate, termYears) {
  return principal * Math.pow(1 + rate / 100, termYears);
}

async function fetchAllCSVData() {
  const fileMappings = {
    taxSavingFd: "tax_fd.csv",
    seniorPublicFd: "senior_public.csv",
    seniorPrivateFd: "senior_private.csv",
    comparisonPublicFd: "public_sector_banks.csv",
    comparisonPrivateFd: "private_sector_banks.csv",
  };

  for (const [key, fileName] of Object.entries(fileMappings)) {
    const csvDocument = await csvFile.findOne({ fileName });
    if (csvDocument) {
      datasets[key] = csvDocument.data; 
    } else {
      console.warn(`CSV file "${fileName}" not found in the database.`);
    }
  }
}

async function loadAndCleanData() {
  await fetchAllCSVData();
  Object.entries(datasets).forEach(([key, data]) => {
    data.forEach((row) => {
      if (key === "taxSavingFd") {
        row["General Citizens"] = row["General Citizens"]
          ? parseFloat(row["General Citizens"].replace(/[^0-9.]/g, "")) || 0
          : undefined;

        row["Senior Citizens"] = row["Senior Citizens"]
          ? parseFloat(row["Senior Citizens"].replace(/[^0-9.]/g, "")) || 0
          : undefined;
      } else {
        Object.keys(row).forEach((col) => {
          if (col === "3-years tenure") {
            row["3-year tenure"] = row[col];
            delete row[col];
          }
          if (col === "5-years tenure") {
            row["5-year tenure"] = row[col];
            delete row[col];
          }
        });

        ["Highest slab", "1-year tenure", "3-year tenure", "5-year tenure"].forEach((col) => {
          if (row[col]) {
            row[col] = parseFloat(row[col].replace(/[^0-9.]/g, ""));
          }
        });
      }
    });

    if (key === "seniorPublicFd" || key === "seniorPrivateFd") {
      datasets[key].forEach(row => {
        delete row["General Citizens"];
        delete row["Senior Citizens"];
      });
    }
  });

  console.log("Data cleaned and processed:", datasets);
}

loadAndCleanData();

function recommendFds(age, amount, termYears) {
  const taxSavingFd = datasets.taxSavingFd;
  const seniorPublicFd = datasets.seniorPublicFd;
  const seniorPrivateFd = datasets.seniorPrivateFd;
  const comparisonPublicFd = datasets.comparisonPublicFd;
  const comparisonPrivateFd = datasets.comparisonPrivateFd;

  let recommendations = [];

  if (age > 60 && amount <= 150000) {
    taxSavingFd.forEach((fd) => {
      const maturityAmount = calculateMaturity(amount, fd['Senior Citizens'], termYears);
      fd['Maturity Amount'] = maturityAmount;
    });

    recommendations = taxSavingFd
      .sort((a, b) => b['Maturity Amount'] - a['Maturity Amount'])
      .slice(0, 3);

    return recommendations.map((fd) => {
      return {
        bank: fd['Banks'],
        interestRate: fd['Senior Citizens'],
        maturityAmount: fd['Maturity Amount'],
        reason: "Tax Saving FD for Senior Citizens"
      };
    });

  } else if (age <= 60 && amount <= 150000) {
    taxSavingFd.forEach((fd) => {
      const maturityAmount = calculateMaturity(amount, fd['General Citizens'], termYears);
      fd['Maturity Amount'] = maturityAmount;
    });

    recommendations = taxSavingFd
      .sort((a, b) => b['Maturity Amount'] - a['Maturity Amount'])
      .slice(0, 3);

    return recommendations.map((fd) => {
      return {
        bank: fd['Banks'],
        interestRate: fd['General Citizens'],
        maturityAmount: fd['Maturity Amount'],
        reason: "Tax Saving FD for General Citizens"
      };
    });

  } else if (age > 60 && amount > 150000) {
    const seniorFd = seniorPublicFd.concat(seniorPrivateFd);
    seniorFd.forEach((fd) => {
      const averageRate = (fd['1-year tenure'] + fd['3-year tenure'] + fd['5-year tenure']) / 3;
      const maturityAmount = calculateMaturity(amount, averageRate, termYears);
      fd['Average Rate (%)'] = averageRate;
      fd['Maturity Amount'] = maturityAmount;
    });

    recommendations = seniorFd
      .sort((a, b) => b['Maturity Amount'] - a['Maturity Amount'])
      .slice(0, 3);

    return recommendations.map((fd) => {
      return {
        bank: fd['Bank Name'],
        interestRate: fd['Average Rate (%)'],
        maturityAmount: fd['Maturity Amount'],
        reason: "Senior Citizen FD (Public & Private Banks)"
      };
    });

  } else if (age <= 60 && amount > 150000) {
    const comparisonFd = comparisonPublicFd.concat(comparisonPrivateFd);
    comparisonFd.forEach((fd) => {
      const averageRate = (fd['1-year tenure'] + fd['3-year tenure'] + fd['5-year tenure']) / 3;
      const maturityAmount = calculateMaturity(amount, averageRate, termYears);
      fd['Average Rate (%)'] = averageRate;
      fd['Maturity Amount'] = maturityAmount;
    });

    recommendations = comparisonFd
      .sort((a, b) => b['Maturity Amount'] - a['Maturity Amount'])
      .slice(0, 3);

    return recommendations.map((fd) => {
      return {
        bank: fd['Public Sector Banks'] || fd['Private Sector Banks'],
        interestRate: fd['Average Rate (%)'],
        maturityAmount: fd['Maturity Amount'],
        reason: "Comparison FD (Public & Private Banks)"
      };
    });

  } else {
    console.log("No recommendations available for the given inputs.");
    return [];
  }
}


//fd end

// mf start

let mutualFundsData = {};
async function fetchAllMFCSVData() {
  const fileMappings = {
    mutualFunds: "mutual_funds_data - Main.csv", 
  };

   

  for (const [key, fileName] of Object.entries(fileMappings)) {
    const csvDocument = await csvFile.findOne({ fileName });

    if (csvDocument) {
      mutualFundsData[key] = csvDocument.data; 
      // console.log(⁠ ${fileName} data loaded successfully! ⁠);
    } else {
      console.log(⁠ "CSV file  not found in the database. ⁠");
        
    }
  }
}

async function recommendMutualFunds(userInput) {
  await fetchAllMFCSVData();
  const { user_age, user_risk_appetite } = userInput;

  console.log(Object.values(mutualFundsData)[0][0]["Risk"])
  let allFunds = Object.values(mutualFundsData).flat();

  // Filter funds by risk
  let filteredData = allFunds.filter(
    (fund) => fund["Risk"] === user_risk_appetite
  );

  filteredData = filteredData.sort((a, b) => {
    return (
      b["Sharpe"] - a["Sharpe"] ||
      b["Alpha"] - a["Alpha"] ||
      a["Beta"] - b["Beta"] ||
      a["Expense ratio"] - b["Expense ratio"] ||
      a["Standard Deviation"] - b["Standard Deviation"]
    );
  });

  let recommendedFunds;
  if (18 <= user_age && user_age < 30) {
    const highRiskFunds = filteredData.filter((fund) => fund["Risk"] === 'High').slice(0, 2);
    const otherFunds = filteredData.filter((fund) => !highRiskFunds.includes(fund)).slice(0, 1);
    recommendedFunds = [...highRiskFunds, ...otherFunds];
  } else if (30 <= user_age && user_age <= 50) {
    const highRiskFunds = filteredData.filter((fund) => fund["Risk"] === 'High').slice(0, 1);
    const otherFunds = filteredData.filter((fund) => !highRiskFunds.includes(fund)).slice(0, 2);
    recommendedFunds = [...highRiskFunds, ...otherFunds];
  } else {
    recommendedFunds = filteredData.filter((fund) => fund["Risk"] !== 'High').slice(0, 3);
  }

  return recommendedFunds;
}

async function getRecommendationFromGroq(userInput, recommendations) {
  const { user_age, user_risk_appetite, user_income, user_savings, user_investment_amount } = userInput;

  const prompt = `
    I want to invest in mutual funds. I am ${user_age} years old. I have a ${user_risk_appetite} risk appetite.
    I earn ${user_income} INR per month. I save ${user_savings} INR per month. From the savings amount, I want to
    invest ${user_investment_amount} INR per month. Analyze these mutual funds and suggest only one mutual fund.
    Give me reasons behind your suggestion.

    ${JSON.stringify(recommendations, null, 2)}`;

  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "llama3-8b-8192",
    });

    return chatCompletion.choices[0]?.message?.content || "No response received.";
  } catch (error) {
    console.error("Error communicating with Groq API:", error);
  }
}






allroutes.post("/recommend-mutual-funds", async (req, res) => {
  const userInput = req.body;

  if (!userInput) {
    return res.status(400).json({ error: "Invalid input: User data is required" });
  }

  try {
    const recommendations = recommendMutualFunds(userInput);

    const groqResponse = await getRecommendationFromGroq(userInput, recommendations);

    res.json({
      recommendations,
      groqRecommendation: groqResponse,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// mf end

const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');


const base64Credentials = process.env.FIREBASE_CREDENTIALS_BASE64;
const credentials = JSON.parse(Buffer.from(base64Credentials, 'base64').toString('utf8'));
admin.initializeApp({
  credential: admin.credential.cert(credentials)
});


allroutes.post("/fdrecommendations", async (req, res) => {
  const userInput = req.body;
  const { age, amount, termYears } = userInput;

  if (!age || !amount || !termYears) {
    return res.status(400).json({ error: "Invalid input: Age, amount, and termYears are required" });
  }

  try {
    const recommendationDetails = recommendFds(age, amount, termYears);
    const bestRecommendation = recommendationDetails[0];
    const prompt = `
      I am ${age} years old and want to invest ${amount} INR for ${termYears} years.
      Based on the following FD option, suggest the best one and explain why it is the best choice given my age, amount, and tenure:

      FD Option:
      - Bank Name: ${bestRecommendation.bank}
      - Interest Rate: ${bestRecommendation.interestRate}%
      - Maturity Amount: INR ${bestRecommendation.maturityAmount}
      - Reason: ${bestRecommendation.reason}

      Please explain why this is the best choice.`;

    const response = await groq.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "llama3-8b-8192",
    });

    const groqRecommendation = response.choices[0]?.message?.content || "No response received.";

    res.json({
      bestRecommendation: {
        bank: bestRecommendation.bank,
        interestRate: bestRecommendation.interestRate,
        maturityAmount: bestRecommendation.maturityAmount,
        reason: bestRecommendation.reason
      },
      groqRecommendation
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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

  if (!formData) {
    return res.status(400).json({ error: 'No form data provided' });
  }

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
    console.error('Error saving or updating data:', error.message);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

allroutes.post('/chatbot4', async (req, res) => {
  const { question } = req.body;
  try {
    const answer = await chat(question);
    res.status(200).json({ answer });

  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

allroutes.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: "No file uploaded" });
        }
        const fileName = req.file.originalname;
        let jsonArray;

        try {
            const readableFile = new Readable();
            readableFile.push(req.file.buffer);
            readableFile.push(null); 
            jsonArray = await csvtojson().fromStream(readableFile);
        } catch (csvError) {
            return res.status(500).json({ message: "Error processing CSV file", error: csvError.message });
        }
        const existingDocument = await csvFile.findOne({ fileName });
        if (existingDocument) {
            existingDocument.data = jsonArray;
            await existingDocument.save();
        } else {
            await csvFile.create({ fileName, data: jsonArray });
        }
        res.status(200).json({ message: `Data from ${fileName} successfully processed` });
    } catch (error) {
        console.error("Error during file upload:", error);
        res.status(500).json({ message: "Failed to process file", error: error.message });
    }
});


module.exports = allroutes;
