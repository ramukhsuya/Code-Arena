require("dotenv").config(); // Load .env file
const express = require("express");
const session = require("express-session");
const path = require("path");
const bodyParser = require("body-parser");
const mongoose = require("mongoose");
const axios = require("axios"); // Add axios for API calls

const app = express();

// Load environment variables
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || "fallback-secret";
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/CodeArena";

// Connect to MongoDB
mongoose.connect(MONGO_URI)
  .then(() => console.log("MongoDB connected successfully"))
  .catch(err => {
    console.error("MongoDB connection error:", err);
    process.exit(1); // Exit process with failure
  });

// Create User Schema and Model
const userSchema = new mongoose.Schema({
  handle: { type: String, required: true, unique: true },
  verified: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static("public"));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
  })
);

// Set EJS as the templating engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Routes
app.get("/", (req, res) => res.render("home"));
app.get("/contests", (req, res) => res.render("contests"));
app.get("/custom-contest", (req, res) => res.render("custom-contest"));
app.get("/problems", (req, res) => res.render("problems"));
app.get("/friends", (req, res) => res.render("friends"));
app.get("/teams", (req, res) => res.render("teams"));
app.get("/profile", (req, res) => res.render("profile"));

// Login route
app.get("/login", (req, res) => {
  res.render("login", { 
    verificationState: req.session.verificationState || 'initial',
    problemLink: req.session.problemLink || null,
    problemName: req.session.problemName || null,
    message: req.session.message || null,
    messageType: req.session.messageType || null
  });
  
  // Clear the message after displaying
  req.session.message = null;
  req.session.messageType = null;
});

// Handle verification request
app.post("/verify-handle", async (req, res) => {
  const { handle } = req.body;
  
  if (!handle) {
    req.session.message = "Please enter a valid CodeForces handle";
    req.session.messageType = "danger";
    return res.redirect("/login");
  }
  
  try {
    // Verify if the handle exists on CodeForces
    const userResponse = await axios.get(`https://codeforces.com/api/user.info?handles=${handle}`);
    
    if (userResponse.data.status !== "OK") {
      req.session.message = "Invalid CodeForces handle. Please try again.";
      req.session.messageType = "danger";
      return res.redirect("/login");
    }
    
    // Get a random problem from CodeForces
    const problemsResponse = await axios.get("https://codeforces.com/api/problemset.problems");
    
    if (problemsResponse.data.status !== "OK") {
      req.session.message = "Failed to fetch problems. Please try again later.";
      req.session.messageType = "danger";
      return res.redirect("/login");
    }
    
    // Get a random problem (preferably an easier one)
    const problems = problemsResponse.data.result.problems;
    const easierProblems = problems.filter(p => p.rating && p.rating <= 1200);
    const randomProblem = easierProblems[Math.floor(Math.random() * easierProblems.length)];
    
    // Store verification info in session
    req.session.verificationState = 'pending';
    req.session.verificationHandle = handle;
    req.session.verificationProblem = randomProblem;
    req.session.verificationStartTime = Date.now();
    req.session.verificationExpiryTime = Date.now() + (150 * 1000); // 150 seconds
    
    // Create problem link
    const problemLink = `https://codeforces.com/problemset/problem/${randomProblem.contestId}/${randomProblem.index}`;
    req.session.problemLink = problemLink;
    req.session.problemName = randomProblem.name;
    
    return res.redirect("/login");
  } catch (error) {
    console.error("Verification error:", error);
    req.session.message = "An error occurred. Please try again.";
    req.session.messageType = "danger";
    return res.redirect("/login");
  }
});

// Verification check route
app.post("/check-verification", async (req, res) => {
  if (!req.session.verificationHandle || !req.session.verificationProblem) {
    req.session.message = "No verification in progress. Please start over.";
    req.session.messageType = "danger";
    req.session.verificationState = 'initial';
    return res.redirect("/login");
  }
  
  if (Date.now() > req.session.verificationExpiryTime) {
    req.session.message = "Verification time expired. Please try again.";
    req.session.messageType = "danger";
    req.session.verificationState = 'initial';
    return res.redirect("/login");
  }
  
  try {
    // Get recent submissions
    const handle = req.session.verificationHandle;
    const problem = req.session.verificationProblem;
    const verificationStartTime = Math.floor(req.session.verificationStartTime / 1000); // Convert to seconds
    
    const response = await axios.get(`https://codeforces.com/api/user.status?handle=${handle}&count=10`);
    
    if (response.data.status !== "OK") {
      req.session.message = "Could not fetch your submissions. Please try again.";
      req.session.messageType = "danger";
      return res.redirect("/login");
    }
    
    const submissions = response.data.result;
    
    // Look for a compilation error submission to the specified problem
    const verificationSubmission = submissions.find(sub => 
      sub.problem.contestId === problem.contestId &&
      sub.problem.index === problem.index &&
      sub.verdict === "COMPILATION_ERROR" &&
      sub.creationTimeSeconds >= verificationStartTime
    );
    
    if (verificationSubmission) {
      // Verification successful - create or update user
      let user = await User.findOne({ handle: handle });
      
      if (!user) {
        user = new User({
          handle: handle,
          verified: true
        });
      } else {
        user.verified = true;
      }
      
      await user.save();
      
      // Set user as logged in
      req.session.user = {
        handle: handle,
        verified: true
      };
      
      // Clear verification data
      req.session.verificationState = 'initial';
      req.session.verificationHandle = null;
      req.session.verificationProblem = null;
      req.session.problemLink = null;
      
      // Redirect to home page
      return res.redirect("/");
    } else {
      req.session.message = "Compilation error submission not found. Make sure you submitted to the correct problem.";
      req.session.messageType = "warning";
      return res.redirect("/login");
    }
  } catch (error) {
    console.error("Verification check error:", error);
    req.session.message = "An error occurred during verification. Please try again.";
    req.session.messageType = "danger";
    return res.redirect("/login");
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
