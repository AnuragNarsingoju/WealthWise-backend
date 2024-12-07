let mongoose = require('mongoose');


let signup = new mongoose.Schema({
    "name":String,
    "phone":String,
    "email":String,
    "password":String,
},{
    timestamps: true 
});


let Signup = mongoose.model('signup', signup);

module.exports = { Signup};
