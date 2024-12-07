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


let Signup = mongoose.model('signup', signup);

module.exports = { Signup};
