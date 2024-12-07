let mongoose = require('mongoose');


let signup = new mongoose.Schema({
    "name": String,
    "phone": String,
    "email": {
        type: String,
        unique: true
    },
    "password": String,
    "profile": String,
    "count": Number
}, {
    timestamps: true 
});


const formDataSchema = new mongoose.Schema({
  email: { type: String , unique: true},
  income: { type: String },
  age: { type: String },
  city: { type: String },
  foodAtHome: { type: String },
  foodAwayFromHome: { type: String },
  housing: { type: String },
  transportation: { type: String },
  healthcare: { type: String },
  education: { type: String },
  entertainment: { type: String },
  personalCare: { type: String },
  apparelAndServices: { type: String },
  tobaccoProducts: { type: String },
  cashContributions: { type: String },
  alcoholicBeverages: { type: String },
  savings: { type: String }
}, {
  timestamps: true
});

const FormData = mongoose.model('FormData', formDataSchema);
let Signup = mongoose.model('signup', signup);

module.exports = { Signup, FormData};
