const mongoose = require('mongoose')
require('dotenv').config({ path: '../.env' });
const connectDB = async () => {
    try {
        await mongoose.connect((process.env.DATABASE_URI).toString(), {
            serverSelectionTimeoutMS: 20000,
            family: 4,
            autoIndex: true,
             });
    } catch (err) {
        console.log(err)
    }
}
module.exports = connectDB  