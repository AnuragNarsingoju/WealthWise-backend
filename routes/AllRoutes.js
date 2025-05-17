
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
const cron = require('node-cron');
const cheerio = require('cheerio');


cron.schedule('0 0 1 * *', async () => {
  try {
      console.log('Resetting count for all users...');
      await Signup.updateMany({}, { count: 0 });
      console.log('Count reset successfully for all users.');
  } catch (error) {
      console.error('Error resetting count:', error.message);
  }
});

// chatbot 
const { Pinecone } = require('@pinecone-database/pinecone');
const { PineconeStore } = require("@langchain/pinecone");
const { PineconeEmbeddings } = require("@langchain/pinecone");
const { ChatGroq } = require("@langchain/groq");
const { PromptTemplate } = require("@langchain/core/prompts");
const { StringOutputParser } = require("@langchain/core/output_parsers");

let retriever1=null;
let retriever2=null;
async function get_retriever() {
    process.env.PINECONE_API_KEY= process.env.PINECONE_API_KEY1;
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
    retriever1 = vectorStore.asRetriever();
    process.env.PINECONE_API_KEY= "";
}


async function get_retrieverExpense() {
  process.env.PINECONE_API_KEY= process.env.PINECONE_API_KEY2;
  const PINECONE_INDEX = "expense";
  const pinecone = new Pinecone();
  const pineconeIndex = pinecone.Index(PINECONE_INDEX);
  const embeddings = new PineconeEmbeddings({
    model: "multilingual-e5-large",
  });
  const vectorStore = await PineconeStore.fromExistingIndex(embeddings, {
    pineconeIndex,
    maxConcurrency: 5,
  });
  retriever2 = vectorStore.asRetriever();
  process.env.PINECONE_API_KEY= "";

}


async function getRetrivers(){
  await get_retriever();
  await get_retrieverExpense();

}

getRetrivers();

async function chat(Question) {
  try {
    const llm = new ChatGroq({
      model: "llama-3.3-70b-versatile",
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
          subQuestions.map((q) => retriever1.invoke(q))
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
    console.log(subQuestions)

    const allDocuments = await retrieveDocuments(subQuestions);



    const topDocuments = await reciprocalRankFusion(allDocuments);
    // console.log(topDocuments)

    const template = PromptTemplate.fromTemplate(
      `You are a financial advisory helper chatbot, "Niveshak," which understands the provided context below and gives a beautiful, understandable response to the user by following these guidelines:

        Question: {question}  

        1. **If the question does NOT relate to finance or personal finance, respond ONLY with:**  
          **"As an AI Chatbot, I cannot provide information on that topic."**  

        2. **If the question includes personal financial details of any individual, such as their investments, assets, net worth, or private financial information, respond ONLY with:**  
          **"I'm sorry, but I cannot provide personal financial details about individuals."**  

        3. **If the user’s question is related to greetings, just greet them appropriately.**  

        4. **If the question is related to finance, provide a comprehensive answer that includes (as applicable):**  
          - A definition  
          - Real-life examples  
          - Personal finance calculations  

        5. **Give responses based on the question. You may include or exclude the above points based on the question’s needs. If the question doesn't require these points, provide only the necessary response.**  

        6. **Use the below context for replying, and always perform calculations in Indian Rupees.**  

        Context: {context} `
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
        interestRate: parseFloat(fd['Senior Citizens'].toFixed(2)),
        maturityAmount: parseFloat(fd['Maturity Amount'].toFixed(2)),
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
        interestRate: parseFloat(fd['General Citizens'].toFixed(2)),
        maturityAmount: parseFloat(fd['Maturity Amount'].toFixed(2)),
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
        interestRate: parseFloat(fd['Average Rate (%)'].toFixed(2)),
        maturityAmount: parseFloat(fd['Maturity Amount'].toFixed(2)),
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
        interestRate: parseFloat(fd['Average Rate (%)'].toFixed(2)),
        maturityAmount: parseFloat(fd['Maturity Amount'].toFixed(2)),
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
    try {
      const csvDocument = await csvFile.findOne({ fileName });
      if (csvDocument && csvDocument.data) {
        mutualFundsData[key] = csvDocument.data;
        console.log(`${fileName} data loaded successfully!`);
      } else {
        console.error(`CSV file ${fileName} not found or has no data.`);
      }
    } catch (error) {
      console.error(`Error loading ${fileName}:`, error.message);
    }
  }
}

async function recommendMutualFunds(userInput) {
  await fetchAllMFCSVData();

  const { user_age, user_risk_appetite } = userInput;

  let allFunds = Object.values(mutualFundsData).flat();
  if (!allFunds || allFunds.length === 0) {
    throw new Error("No mutual funds data available.");
  }

  let filteredData = allFunds.filter(
    (fund) => fund["Risk"] === user_risk_appetite
  );

  if (filteredData.length === 0) {
    throw new Error("No funds match the given risk appetite.");
  }

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
    console.error("Error communicating with Groq API:", error.message);
    return "Unable to get a recommendation at this time.";
  }
}

allroutes.post("/recommend-mutual-funds", async (req, res) => {
  const userInput = req.body;

  if (!userInput) {
    return res.status(400).json({ error: "Invalid input: User data is required" });
  }

  try {
    const recommendations = await recommendMutualFunds(userInput); // Added await
    const groqResponse = await getRecommendationFromGroq(userInput, recommendations);

    res.json({
      recommendations,
      groqRecommendation: groqResponse,
    });
  } catch (error) {
    console.error("Error in recommendation route:", error.message);
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
      Please explain why this is the best choice in 500 to 600 characters, starting with the bank name, maturity amount, and reasons for selection.`;
    const response = await groq.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      model: "llama3-8b-8192",
    });

    let groqRecommendation = response.choices[0]?.message?.content || "No response received.";
    groqRecommendation = groqRecommendation.slice(0, 600);
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
            const token = jwt.sign({ "email": email }, process.env.TOKEN);
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

allroutes.get('/findmail', async (req, res) => {
  const { email } = req.query;
  try {
    const newUser = await Signup.findOne({ email: email });
    if (!newUser) {
       return res.status(404).json({ message: 'No user found with this email' });
    }
    
    return res.status(200).json({ message: 'User found', count: newUser.count });
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

    const { email, income, age, city } = formData;
    if (!email || !income || !age || !city) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;  
    const existingData = await UserData.findOne({
      email,
      month
});

    if (existingData) {
      Object.assign(existingData, {
        income:formData.income || existingData.income,
        age:formData.age || existingData.age,
        city:formData.city || existingData.city,
        foodAtHome: formData.foodAtHome || existingData.foodAtHome,
        foodAwayFromHome: formData.foodAwayFromHome || existingData.foodAwayFromHome,
        housing: formData.housing || existingData.housing,
        transportation: formData.transportation || existingData.transportation,
        healthcare: formData.healthcare || existingData.healthcare,
        education: formData.education || existingData.education,
        entertainment: formData.entertainment || existingData.entertainment,
        personalCare: formData.personalCare || existingData.personalCare,
        apparelAndServices: formData.apparelAndServices || existingData.apparelAndServices,
        tobaccoProducts: formData.tobaccoProducts || existingData.tobaccoProducts,
        personalfinance: formData.personalfinance || existingData.personalfinance,
        alcoholicBeverages: formData.alcoholicBeverages || existingData.alcoholicBeverages,
        savings: formData.savings || existingData.savings,
        others: formData.others || existingData.others,
      });

      await existingData.save();
      return res.status(200).json({ message: 'Data updated successfully', data: existingData });
    } else {
      // Create new data
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const newData = new UserData({
        email: formData.email || '',
        income: formData.income || '',
        age: formData.age || '',
        city: formData.city || '',
        foodAtHome: formData.foodAtHome || '',
        foodAwayFromHome: formData.foodAwayFromHome || '',
        housing: formData.housing || '',
        transportation: formData.transportation || '',
        healthcare: formData.healthcare || '',
        education: formData.education || '',
        entertainment: formData.entertainment || '',
        personalCare: formData.personalCare || '',
        apparelAndServices: formData.apparelAndServices || '',
        tobaccoProducts: formData.tobaccoProducts || '',
        personalfinance: formData.personalfinance || '',
        alcoholicBeverages: formData.alcoholicBeverages || '',
        savings: formData.savings || '',
        others: formData.others || '',
        date: new Date(),
        month:month
      });

      await newData.save();
      return res.status(201).json({ message: 'Data saved successfully', data: newData });
    }
  } catch (error) {
    console.error('Error saving or updating data:', error.message);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

allroutes.get('/getData', async (req, res) => {
  try {
    const email = req.query.email;
    console.log(email)
    const userData = await UserData.find({ email }); 
  
    res.json(userData); 
  } catch (error) {
    console.error("Error fetching user data:", error);
    res.status(500).send("Internal Server Error");
  }
});


allroutes.post('/chatbot4', async (req, res) => {
  try {
    let { question } = req.body; 
    question = question.toLowerCase();
    const answer = await chat(question);
    res.status(200).json({ answer }); 
  } catch (error) {
    res.status(400).json({ error: error.message }); 
  }
});


allroutes.post('/getAnalysis', async(req, res) => {
  const { salary, age, cityType, userExpenses,data } = req.body;
  
  try {
      class BudgetReportGenerator {
          static BENCHMARK_EXPENSES = {
              foodAtHome: 9.8,
              foodAwayFromHome: 5.9,
              alcoholicBeverages: 0.6,
              housing: 24,
              apparelAndServices: 2,
              transportation: 12,
              healthCare: 6,
              entertainment: 3.5,
              personalCare: 1,
              education: 2,
              tobacco: 0.5,
              other: 1.5,
              personalFinanceAndPensions: 10,
              savings: 22
          };
          static CITY_MULTIPLIERS = {
              metro: 1.3,
              tier1: 1.15,
              tier2: 1,
              tier3: 0.85,
              rural: 0.7
          };
          static AGE_MULTIPLIERS = {
              '18-25': 0.9,
              '26-35': 1.1,
              '36-45': 1.2,
              '46-55': 1.0,
              '56-65': 0.8,
              '65+': 0.7
          };
          constructor(salary, age, cityType) {
              this.salary = parseFloat(salary);
              this.age = parseInt(age);
              this.cityType = (cityType && cityType.toLowerCase()) || 'tier2';
          }
          _getAgeGroup() {
              if (this.age >= 18 && this.age <= 25) return '18-25';
              if (this.age >= 26 && this.age <= 35) return '26-35';
              if (this.age >= 36 && this.age <= 45) return '36-45';
              if (this.age >= 46 && this.age <= 55) return '46-55';
              if (this.age >= 56 && this.age <= 65) return '56-65';
              return '65+';
          }
          generateBenchmarkExpenses() {
              const cityMultiplier = BudgetReportGenerator.CITY_MULTIPLIERS[this.cityType] || 1;
              const ageMultiplier = BudgetReportGenerator.AGE_MULTIPLIERS[this._getAgeGroup()] || 1;

              const benchmarkExpenses = {};

              for (const [category, percentage] of Object.entries(BudgetReportGenerator.BENCHMARK_EXPENSES)) {
                  const baseAmount = this.salary * (percentage / 100);
                  const adjustedAmount = baseAmount * cityMultiplier * ageMultiplier;

                  benchmarkExpenses[category] = {
                      percentage: percentage,
                      amount: Math.round(adjustedAmount)
                  };
              }
              return benchmarkExpenses;
          }
          compareExpenses(userExpenses) {
              const benchmarkExpenses = this.generateBenchmarkExpenses();
              const comparisonReport = {};

              for (const [category, benchmarkData] of Object.entries(benchmarkExpenses)) {
                  const userExpense = userExpenses[category] || 0;

                  comparisonReport[category] = {
                      benchmark: benchmarkData.amount,
                      userExpense: userExpense,
                      difference: userExpense - benchmarkData.amount,
                      variancePercentage: Math.round((userExpense / benchmarkData.amount - 1) * 100)
                  };
              }
              return comparisonReport;
          }
          generateWhatIfScenarios() {
              const scenarios = {
                  saveMore: {
                      title: "Aggressive Savings Scenario",
                      description: "Reduce discretionary expenses and increase savings",
                      savings: Math.round(this.salary * 0.3)
                  },
                  emergencyFund: {
                      title: "Emergency Fund Building",
                      description: "Create a 6-month emergency fund",
                      monthlyContribution: Math.round(this.salary * 0.2)
                  },
                  investmentGrowth: {
                      title: "Long-term Investment Growth",
                      description: "Potential investment returns over 10 years",
                      annualInvestment: Math.round(this.salary * 0.15),
                      projectedGrowth: Math.round(this.salary * 0.15 * 10 * 1.12)
                  }
              };
              return scenarios;
          }

          generateReport(userExpenses) {
              return {
                  salaryDetails: {
                      monthlySalary: this.salary,
                      ageGroup: this._getAgeGroup(),
                      cityType: this.cityType
                  },
                  expensesComparison: this.compareExpenses(userExpenses),
              };
          }
          generateInsights(userExpenses) {
              const comparisonReport = this.compareExpenses(userExpenses);
              const insights = [];
              for (const [category, comparison] of Object.entries(comparisonReport)) {
                  if (Math.abs(comparison.variancePercentage) > 30) {
                      insights.push({
                          category: category,
                          type: comparison.variancePercentage > 0 ? 'overspending' : 'underspending',
                          message: `Your ${category} expenses are ${Math.abs(comparison.variancePercentage)}% ${comparison.variancePercentage > 0 ? 'higher' : 'lower'} than recommended.`
                      });
                  }
              }
              return insights;
          }
      }
      if (!salary || !age || !cityType || !userExpenses) {
          return res.status(400).json({ message: 'Missing required fields' });
      }
      const reportGenerator = new BudgetReportGenerator(salary, age, cityType);
      const report = reportGenerator.generateReport(userExpenses);
      const insights = reportGenerator.generateInsights(userExpenses);


      const llmdata = {
        report,
        insights,
        scenarios: reportGenerator.generateWhatIfScenarios()
      }

      const expenseAnalysis = async () => {
        const Question  = llmdata;
        try {
            const llm = new ChatGroq({
                model: "llama3-8b-8192",
                temperature: 0,
                maxTokens: undefined,
                maxRetries: 5,
            });
    
            const generateQueries = async (data) => {
                try {
                    const template = PromptTemplate.fromTemplate(
                        `You are a helpful assistant tasked with generating multiple sub-questions related to a given input question.
                        The goal is to break down the input question into a set of sub-problems or sub-questions that can be used to fetch documents from a vector store.
                        Provide the questions in the following structured format, starting with a number followed by a period and a space, then the question text, ending with a question mark. Limit the output to 10 questions, each on a new line.
                        
                        Example Output:
                        
                        1. How can the user categorize their spending to identify unnecessary expenses in rupees?
                        2. What steps can the user take to create a personalized savings plan in rupees?
                        3. How can the user track their expenses in rupees to ensure they stick to a budget?
                        4. What tools or apps can the user use in India to automate their budgeting process?
                        5. How can the user identify patterns in their spending habits over time in rupees?
                        6. What are some practical ways to reduce fixed monthly expenses in India?
                        7. How can the user allocate their income in rupees to achieve specific savings goals?
                        8. What role do emergency funds play in effective money management in India?
                        9. How can the user balance spending on necessities and leisure in rupees?
                        10. How can the user set realistic financial goals in rupees based on their current spending analysis?
                        
                        Search queries related to: {data}:
                        `
                    );
    
                    const formattedPrompt = await template.format({ data: data });
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
                        subQuestions.map((q) => retriever2.invoke(q))
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
    
            const subQuestions = await generateQueries(Question);
    
            const allDocuments = await retrieveDocuments(subQuestions);
            const topDocuments = await reciprocalRankFusion(allDocuments);
            console.log(topDocuments);
    
    
            const finalTemplate = PromptTemplate.fromTemplate(
              `user expenses data : {user_expenses_data}
              
              Objective: Create an engaging financial narrative with actionable strategies based on user data.
              
              Guidance Requirements:
              Personalized Financial Story
              
              Narrate the user’s financial journey, linking spending to values and goals.
              Identify turning points, opportunities, and highlight surprising insights.
              Tailored Budgeting Techniques
              
              Provide personality-driven approaches (e.g., analytical, visual learners, tech-savvy).
              Include innovative methods like 50/30/20, zero-based, reverse, or adaptive budgeting.
              Explain why they work, step-by-step implementation, and challenges.
              Advanced Saving Strategies
              
              Suggest micro-savings, gamification, automated savings, and reward-based methods.
              Core Purpose: Transform data into a motivating, personalized financial narrative that inspires action, empowers the user, and provides clear, practical steps toward financial growth and security.
              Note: All monetary values and suggestions should be presented in Indian Rupees (₹) instead of dollars ($).
              also use below context for giving response . context : {context}`
            );
            const finalPrompt = await finalTemplate.format({
                user_expenses_data: Question,
                context: topDocuments
            });
            const outputParser = new StringOutputParser();
            const finalOutput = await outputParser.parse(await llm.invoke(finalPrompt));
            return (finalOutput.content);
        } catch (error) {
            console.error("Error in chat function:", error);
            return "An error occurred while processing your request.";
        }
    }

    const userData = await UserData.findOne({ _id: data._id });
    let llmres;
    if (!userData) {
        console.error("User data not found.");
        return;
    }
    if (!userData.llm || userData.llm === "") {
        llmres = await expenseAnalysis(); 
        userData.llm = llmres; 
        await userData.save(); 
    } else {
        llmres = userData.llm;
    }

    const resopnse = {
      report,
      insights,
      scenarios: reportGenerator.generateWhatIfScenarios(),
      llmres
    }
    res.status(200).json({
      resopnse
    });
  } catch (e) {
      res.status(500).json({ message: "Failed to Get Analysis", error: e.message });
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


const postStockRecommendation = async (question) => {
  const url = 'https://keen-marten-tops.ngrok-free.app/stockRecommandation';
  try {
    const response = await axios.post(url, question);
    return response.data;
  } catch (error) {
    console.log("Error:", error);
    throw new Error("Error fetching stock recommendation");
  }
};


allroutes.post('/PersonalizedStocks', async (req, res) => {
  const { formData } = req.body;
  try {
    const answer = await postStockRecommendation(formData); 
    res.status(200).json({ answer }); 
  } catch (error) {
    res.status(400).json({ error: error.message }); 
  }
});


allroutes.get("/getbalance", async (req, res) => {
  try {
    const { userId } = req.query;
    // console.log(userId);
    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }
    const user = await Signup.findOne({ email: userId });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ user });
  } catch (error) {
    console.error("Error fetching balance:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});



allroutes.get('/nifty50', async (req, res) => {
  try {
    const { data: html } = await axios.get('https://www.moneyworks4me.com/best-index/nse-stocks/top-nifty-50-companies-list/');
    const $ = cheerio.load(html);

    const top50 = [];

    $('tr.table-content').each((_, row) => {
      const cols = $(row).find('td');

      const companyName = $(cols[1]).find('a').text().trim();
      const lastPrice = parseFloat($(cols[2]).text().replace(/,/g, ''));
      const percentChangeText = $(cols[3]).text().trim();
      const percentChange = percentChangeText ? parseFloat(percentChangeText.replace('%', '')) : undefined;

      const highText = $(cols[5]).text().split('\n')[0].trim();
      const lowText = $(cols[6]).text().split('\n')[0].trim();

      const symbol = companyName?.split(' ')[0].toUpperCase();

      const stock = {
        symbol,
        lastPrice: isNaN(lastPrice) ? undefined : lastPrice,
        percentChange: isNaN(percentChange) ? undefined : percentChange,
        high: isNaN(parseFloat(highText)) ? undefined : parseFloat(highText),
        low: isNaN(parseFloat(lowText)) ? undefined : parseFloat(lowText),
      };

      top50.push(Object.fromEntries(Object.entries(stock).filter(([_, v]) => v !== undefined)));
    });

    res.json(top50);
  } catch (error) {
    console.error('Error scraping Nifty 50 data:', error.message);
    res.status(500).json({ error: 'Failed to fetch Nifty 50 data' });
  }
});




allroutes.put("/updatebalance", async (req, res) => {
  try {
    const { email, balance } = req.body;
    let user = await signupModel.findOne({ email: email });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    user.balance = balance;
    await user.save();
    res.status(200).json({ message: "Balance updated successfully", user });
  } catch (error) {
    res.status(500).json({ message: "Internal Server Error" });
  }
});

allroutes.get("/getvalue", async (req, res) => {
  try {
    const { email } = req.query;
    let user = await Signup.findOne({ email: email });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    let sum = 0;
    const stocks = user.stocks;
    for (let i = 0; i < stocks.length; i++) {
      const quote = await yahooFinance.quote(stocks[i].symbol);
      sum += quote.regularMarketPrice;
    }
    sum = parseFloat(sum.toFixed(2));
    user.pvalue = sum;
    await user.save();
    res.status(200).json({
      amount: sum,
    });
  } catch (error) {
    res.status(500).json({ message: "Internal Server Error" });
  }
});

allroutes.get("/portfolio-profit-loss", async (req, res) => {
  try {
    const { email } = req.query;
    const user = await Signup.findOne({ email: email });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    let totalProfitOrLoss = 0;
    let stockDetails = [];
    for (let stock of user.stocks) {
      const { symbol, boughtPrice, quantity } = stock;
      const quote = await yahooFinance.quote(symbol);
      const currentPrice = quote.regularMarketPrice;

      const profitOrLoss = (currentPrice - boughtPrice) * quantity;
      totalProfitOrLoss += profitOrLoss;

      stockDetails.push({
        symbol,
        boughtPrice,
        currentPrice,
        quantity,
        profitOrLoss: parseFloat(profitOrLoss.toFixed(2)),
      });
    }
    res.status(200).json({
      stocks: stockDetails,
      totalProfitOrLoss: parseFloat(totalProfitOrLoss.toFixed(2)),
    });
  } catch (error) {
    console.error("Error fetching stock data:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

const yahooFinance = require("yahoo-finance2").default;
allroutes.get("/stock-price", async (req, res) => {
  try {
    const { tickers } = req.body;
    const prices = [];
    for (let i = 0; i < tickers.length; i++) {
      const quote = await yahooFinance.quote(tickers[i]);
      console.log(
        `Current price of ${tickers[i]}: ₹${quote.regularMarketPrice}`
      );
      prices.push(quote.regularMarketPrice);
    }
    res.json({ price: prices });
  } catch (error) {
    console.error("Error fetching data:", error);
    res.status(500).json({ error: "Failed to fetch data" });
  }
});


// Initialize NSE India API
const nseIndia = new NseIndia();

// Route to search for a stock by name/symbol
allroutes.get("/api/stock/search", async (req, res) => {
  try {
    const { query } = req.query;

    if (!query) {
      return res.status(400).json({ error: "Search query is required" });
    }

    // Get all equity symbols from NSE
    const equitySymbols = await nseIndia.getAllStockSymbols();

    // Filter symbols based on the query (case insensitive)
    const filteredSymbols = equitySymbols.filter((symbol) =>
      symbol.toLowerCase().includes(query.toLowerCase())
    );

    // Limit results to top 10 matches
    const results = filteredSymbols.slice(0, 10);

    res.json({ results });
  } catch (error) {
    console.error("Error searching for stocks:", error);
    res.status(500).json({ error: "Failed to search for stocks" });
  }
});

// Route to get stock details and current price
allroutes.get("/stock/price", async (req, res) => {
  try {
    console.log("Aagaya baap");
    const { symbol } = req.query;

    if (!symbol) {
      return res.status(400).json({ error: "Stock symbol is required" });
    }

    // Get stock details from NSE
    const stockDetails = await nseIndia.getEquityDetails(symbol);
    console.log(stockDetails);

    // Get current market price
    const priceInfo = stockDetails.priceInfo.close;

    return res.json({
      symbol,
      name: stockDetails.info.companyName,
      price: priceInfo,
    });
  } catch (error) {
    console.error("Error fetching stock price:", error);
    res.status(500).json({ error: "Failed to fetch stock price" });
  }
});

// Route to buy stocks
allroutes.post("/stock/buy", async (req, res) => {
  try {
    const { email, symbol, quantity } = req.body;

    if (!email || !symbol || !quantity) {
      return res
        .status(400)
        .json({ error: "Email, symbol, and quantity are required" });
    }

    // Find the user
    const user = await Signup.findOne({ email });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Get current stock price
    const priceInfo = await nseIndia.getEquityDetails(symbol);
    const currentPrice = priceInfo.priceInfo.lastPrice;

    // Calculate total cost
    const totalCost = currentPrice * quantity;

    // Check if user has enough balance
    if (user.balance < totalCost) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    // Update user's balance
    user.balance -= totalCost;

    // Check if user already owns this stock
    const existingStockIndex = user.stocks.findIndex(
      (stock) => stock.symbol === symbol
    );

    if (existingStockIndex !== -1) {
      // Update existing stock
      const existingStock = user.stocks[existingStockIndex];
      const newQuantity = existingStock.quantity + parseInt(quantity);
      const newAvgPrice =
        (existingStock.boughtPrice * existingStock.quantity +
          currentPrice * parseInt(quantity)) /
        newQuantity;

      user.stocks[existingStockIndex].quantity = newQuantity;
      user.stocks[existingStockIndex].boughtPrice = newAvgPrice;
    } else {
      // Add new stock to portfolio
      user.stocks.push({
        symbol,
        boughtPrice: currentPrice,
        quantity: parseInt(quantity),
      });
    }

    // Update portfolio value
    let portfolioValue = 0;
    for (const stock of user.stocks) {
      try {
        const stockPrice = await nseIndia.getEquityDetails(stock.symbol);
        portfolioValue += stockPrice.priceInfo.lastPrice * stock.quantity;
      } catch (error) {
        console.error(`Error fetching price for ${stock.symbol}:`, error);
      }
    }
    user.pvalue = portfolioValue;

    // Save user
    await user.save();

    res.json({
      message: "Stock purchased successfully",
      transaction: {
        type: "buy",
        symbol,
        quantity: parseInt(quantity),
        price: currentPrice,
        total: totalCost,
      },
      newBalance: user.balance,
      portfolioValue: user.pvalue,
    });
  } catch (error) {
    console.error("Error buying stock:", error);
    res.status(500).json({ error: "Failed to buy stock" });
  }
});

// Route to sell stocks
allroutes.post("/stock/sell", async (req, res) => {
  try {
    const { email, symbol, quantity } = req.body;

    if (!email || !symbol || !quantity) {
      return res
        .status(400)
        .json({ error: "Email, symbol, and quantity are required" });
    }

    // Find the user
    const user = await Signup.findOne({ email });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Check if user owns this stock
    const stockIndex = user.stocks.findIndex(
      (stock) => stock.symbol === symbol
    );

    if (stockIndex === -1) {
      return res.status(400).json({ error: "You do not own this stock" });
    }

    const stock = user.stocks[stockIndex];

    // Check if user has enough quantity to sell
    if (stock.quantity < quantity) {
      return res.status(400).json({ error: "Not enough shares to sell" });
    }

    // Get current stock price
    const priceInfo = await nseIndia.getEquityDetails(symbol);
    const currentPrice = priceInfo.priceInfo.lastPrice;

    // Calculate total sale amount
    const totalSale = currentPrice * quantity;

    // Update user's balance
    user.balance += totalSale;

    // Update stock quantity or remove if selling all
    if (stock.quantity === parseInt(quantity)) {
      // Remove stock from portfolio
      user.stocks.splice(stockIndex, 1);
    } else {
      // Update quantity
      user.stocks[stockIndex].quantity -= parseInt(quantity);
    }

    // Update portfolio value
    let portfolioValue = 0;
    for (const stock of user.stocks) {
      try {
        const stockPrice = await nseIndia.getEquityDetails(stock.symbol);
        portfolioValue += stockPrice.priceInfo.lastPrice * stock.quantity;
      } catch (error) {
        console.error(`Error fetching price for ${stock.symbol}:`, error);
      }
    }
    user.pvalue = portfolioValue;

    // Save user
    await user.save();

    res.json({
      message: "Stock sold successfully",
      transaction: {
        type: "sell",
        symbol,
        quantity: parseInt(quantity),
        price: currentPrice,
        total: totalSale,
      },
      newBalance: user.balance,
      portfolioValue: user.pvalue,
    });
  } catch (error) {
    console.error("Error selling stock:", error);
    res.status(500).json({ error: "Failed to sell stock" });
  }
});

// Route to get user portfolio
allroutes.get("/portfolio", async (req, res) => {
  try {
    const { email } = req.query;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    // Find the user
    const user = await Signup.findOne({ email });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Get current prices for all stocks in portfolio
    const portfolio = [];
    let totalValue = 0;
    let totalInvestment = 0;
    let totalProfitLoss = 0;
    let profitableStocks = 0;
    let lossStocks = 0;

    for (const stock of user.stocks) {
      try {
        const priceInfo = await nseIndia.getEquityDetails(stock.symbol);
        const currentPrice = priceInfo.priceInfo.lastPrice;
        const stockValue = currentPrice * stock.quantity;
        const investmentValue = stock.boughtPrice * stock.quantity;
        const profitLoss = (currentPrice - stock.boughtPrice) * stock.quantity;
        const profitLossPercentage =
          ((currentPrice - stock.boughtPrice) / stock.boughtPrice) * 100;

        portfolio.push({
          symbol: stock.symbol,
          quantity: stock.quantity,
          boughtPrice: stock.boughtPrice,
          currentPrice,
          value: stockValue,
          profitLoss,
          profitLossPercentage,
        });

        // Track profitable vs loss-making stocks
        if (profitLoss > 0) {
          profitableStocks++;
        } else if (profitLoss < 0) {
          lossStocks++;
        }

        totalValue += stockValue;
        totalInvestment += investmentValue;
        totalProfitLoss += profitLoss;
      } catch (error) {
        console.error(`Error fetching price for ${stock.symbol}:`, error);

        portfolio.push({
          symbol: stock.symbol,
          quantity: stock.quantity,
          boughtPrice: stock.boughtPrice,
          error: "Failed to fetch current price",
        });
      }
    }

    // Calculate overall portfolio performance
    const overallProfitLossPercentage =
      totalInvestment > 0 ? (totalProfitLoss / totalInvestment) * 100 : 0;

    // Generate insights
    // Filter out stocks with errors for performance analysis
    const validStocks = portfolio.filter((stock) => !stock.error);

    // Only calculate best performer if we have valid stocks
    let bestPerformer = null;
    if (validStocks.length > 0) {
      bestPerformer = validStocks.reduce(
        (best, current) =>
          current.profitLossPercentage > best.profitLossPercentage
            ? current
            : best,
        validStocks[0]
      );

      // Only keep best performer if it's actually in profit
      if (bestPerformer.profitLossPercentage <= 0) {
        bestPerformer = null;
      }
    }

    // Only calculate worst performer if we have valid stocks
    let worstPerformer = null;
    if (validStocks.length > 0) {
      // Only consider stocks that are in loss or underperforming
      const underperformingStocks = validStocks.filter(
        (stock) =>
          stock.profitLossPercentage < 0 ||
          (validStocks.length > 1 &&
            stock.profitLossPercentage <
              validStocks.reduce((sum, s) => sum + s.profitLossPercentage, 0) /
                validStocks.length)
      );

      if (underperformingStocks.length > 0) {
        worstPerformer = underperformingStocks.reduce(
          (worst, current) =>
            current.profitLossPercentage < worst.profitLossPercentage
              ? current
              : worst,
          underperformingStocks[0]
        );
      }
    }

    const insights = {
      overallStatus:
        totalProfitLoss > 0
          ? "Profit"
          : totalProfitLoss < 0
          ? "Loss"
          : "Neutral",
      totalProfitLoss,
      overallProfitLossPercentage,
      profitableStocks,
      lossStocks,
      bestPerformer,
      worstPerformer,
    };

    // Update portfolio value in database
    user.pvalue = totalValue;
    await user.save();

    res.json({
      balance: user.balance,
      portfolio,
      totalValue,
      totalInvestment,
      insights,
    });
  } catch (error) {
    console.error("Error fetching portfolio:", error);
    res.status(500).json({ error: "Failed to fetch portfolio" });
  }
});




module.exports = allroutes;
