let mongoose = require('mongoose');


let setsilverprice = new mongoose.Schema({
    "Silver": Number
},{
    timestamps: true 
});


let silverprice = mongoose.model('silverprice', setsilverprice);

module.exports = { silverprice};
