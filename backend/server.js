
const express = require("express");
const mysql = require("mysql2/promise");
const crypto = require("crypto");
const session = require("express-session");
const path = require("path");

// Import DegreePath modules
const { createPlannerRouter } = require("./planner");
const { createScheduleModule } = require("./schedule");

const {
    createHandbookRouter,
    initializeHandbookTables
} = require("./handbooks");

const app = express();
const PORT = 3000;

// --------------------------------------------------
// ENVIRONMENT VARIABLES
// --------------------------------------------------

// Check that the database password and session secret exist
if (!process.env.DB_PASSWORD || !process.env.SESSION_SECRET) {
    console.error("Please set DB_PASSWORD and SESSION_SECRET.");
    process.exit(1);
}

// --------------------------------------------------
// MIDDLEWARE
// --------------------------------------------------

// Read information submitted through HTML forms
app.use(express.urlencoded({ extended: true }));

// Read JSON data sent from the frontend
app.use(express.json());

// Configure session storage so users remain logged in
app.use(session({
    name: "degreepath.sid",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 60 * 60 * 1000, // One hour
        httpOnly: true,
        sameSite: "lax",
        secure: false // Used for local development
    }
}));

// Serve HTML, CSS, and JavaScript files
app.use(express.static(path.join(__dirname, "public")));

// --------------------------------------------------
// MYSQL DATABASE CONNECTION
// --------------------------------------------------

// Create a connection pool for MySQL
// A pool allows multiple database requests efficiently
const db = mysql.createPool({
    host: "127.0.0.1",
    user: "degreepath_app",
    password: process.env.DB_PASSWORD,
    database: "degreepath_db",
    port: 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Initialize the academic planning module using the same database
const planner = createPlannerRouter(db);

// Reuse the same MySQL pool for the weekly class schedule
const schedule = createScheduleModule(db);

// --------------------------------------------------
// HELPER FUNCTIONS
// --------------------------------------------------

// Convert plain passwords into secure hashes
function hashPassword(password, salt) {
    return crypto.pbkdf2Sync(
        password,
        salt,
        210000,
        64,
        "sha512"
    ).toString("hex");
}

// Prevent user-provided text from being interpreted as HTML
function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function(char) {
        const characters = {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        };

        return characters[char];
    });
}

// Generate a basic DegreePath response page
function responsePage(message, content = `
    <p><a href="/login.html">Back to Login</a></p>
    <p><a href="/register.html">Register</a></p>
`) {
    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport"
                  content="width=device-width, initial-scale=1.0">

            <title>DegreePath</title>

            <link rel="stylesheet" href="/style.css">
        </head>

        <body>
            <main class="container">

                <h1>DegreePath</h1>

                <h2>${message}</h2>

                ${content}

            </main>
        </body>
        </html>
    `;
}

// --------------------------------------------------
// AUTHENTICATION MIDDLEWARE
// --------------------------------------------------

// Protect HTML pages from users who are not logged in
function requireLogin(req, res, next) {
    if (!req.session.user) {
        return res.redirect("/login.html");
    }

    next();
}

// Protect API endpoints from unauthorized access
function requireApiLogin(req, res, next) {
    if (!req.session.user) {
        return res.status(401).json({
            error: "You must be logged in to continue."
        });
    }

    next();
}

// Handle errors from asynchronous database operations
function asyncRoute(handler) {
    return function(req, res, next) {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}

// --------------------------------------------------
// HOMEPAGE
// --------------------------------------------------

// Redirect visitors based on whether they are logged in
app.get("/", function(req, res) {
    if (req.session.user) {
        return res.redirect("/dashboard");
    }

    res.redirect("/login.html");
});

// --------------------------------------------------
// REGISTER
// --------------------------------------------------

// Add a new user to the existing MySQL users table
app.post("/register", asyncRoute(async function(req, res) {
    const username = String(req.body.username || "").trim();
    const email = String(req.body.email || "").trim();
    const password = req.body.password || "";

    // Validate registration information
    if (
        !username ||
        !email ||
        username.length > 50 ||
        email.length > 100 ||
        typeof password !== "string" ||
        password.length < 8
    ) {
        return res.status(400).send(
            responsePage("Please enter valid registration details.")
        );
    }

    // Generate a unique salt for the password
    const salt = crypto.randomBytes(16).toString("hex");

    // Hash the password before saving it
    const passwordHash = hashPassword(password, salt);

    const sql = `
        INSERT INTO users
        (
            username,
            email,
            password_hash,
            password_salt,
            first_name,
            last_name
        )
        VALUES (?, ?, ?, ?, ?, ?)
    `;

    try {
        await db.execute(sql, [
            username,
            email,
            passwordHash,
            salt,
            username,
            ""
        ]);

        res.send(
            responsePage(
                "You have successfully registered!",
                `
                <p>Your DegreePath account is ready.</p>
                <p><a href="/login.html">Login Here</a></p>
                `
            )
        );

    } catch (err) {
        if (err.code === "ER_DUP_ENTRY") {
            return res.status(409).send(
                responsePage("Username or email already exists.")
            );
        }

        throw err;
    }
}));

// --------------------------------------------------
// LOGIN
// --------------------------------------------------

// Check the entered credentials against the MySQL database
app.post("/login", asyncRoute(async function(req, res) {
    const username = String(req.body.username || "").trim();
    const password = req.body.password || "";

    if (!username || typeof password !== "string") {
        return res.status(401).send(
            responsePage("Incorrect username or password.")
        );
    }

    // Retrieve the user's stored password information
    const sql = `
        SELECT
            user_id,
            username,
            password_hash,
            password_salt
        FROM users
        WHERE username = ?
    `;

    const [results] = await db.execute(sql, [username]);

    // Reject usernames that do not exist
    if (
        results.length === 0 ||
        !results[0].password_hash ||
        !results[0].password_salt
    ) {
        return res.status(401).send(
            responsePage("Incorrect username or password.")
        );
    }

    const user = results[0];

    // Hash the entered password using the stored salt
    const enteredHash = Buffer.from(
        hashPassword(password, user.password_salt),
        "hex"
    );

    const savedHash = Buffer.from(
        user.password_hash,
        "hex"
    );

    // Compare the password hashes securely
    const validPassword =
        enteredHash.length === savedHash.length &&
        crypto.timingSafeEqual(enteredHash, savedHash);

    if (!validPassword) {
        return res.status(401).send(
            responsePage("Incorrect username or password.")
        );
    }

    // --------------------------------------------------
    // CREATE LOGIN SESSION
    // --------------------------------------------------

    // Generate a fresh session after successful authentication
    req.session.regenerate(function(sessionErr) {
        if (sessionErr) {
            console.error("Session creation error:", sessionErr);

            return res.status(500).send(
                responsePage("Could not start your session.")
            );
        }

        // Store user information in the session
        // Passwords are never stored in the session
        req.session.user = {
            user_id: user.user_id,
            username: user.username
        };

        // Save the session before redirecting
        req.session.save(function(saveErr) {
            if (saveErr) {
                console.error("Session save error:", saveErr);

                return res.status(500).send(
                    responsePage("Could not save your session.")
                );
            }

            // Redirect the user to their academic dashboard
            res.redirect("/dashboard");
        });
    });
}));

// --------------------------------------------------
// PROTECTED DASHBOARD
// --------------------------------------------------

// Display the academic dashboard after successful login
app.get("/dashboard", requireLogin, function(req, res) {
    res.sendFile(
        path.join(__dirname, "public", "dashboard.html")
    );
});

// --------------------------------------------------
// HANDBOOK WORKSPACE
// --------------------------------------------------

// Display the handbook upload and extraction page
// Only authenticated users can access this page
app.get("/handbook", requireLogin, function(req, res) {
    res.sendFile(
        path.join(__dirname, "public", "handbook.html")
    );
});

// --------------------------------------------------
// WEEKLY CLASS SCHEDULE
// --------------------------------------------------

// Class timetable page: only accessible after login
app.get("/schedule", requireLogin, function(req, res) {
    res.sendFile(
        path.join(__dirname, "public", "schedule.html")
    );
});

// --------------------------------------------------
// PROFILE
// --------------------------------------------------

// Display information stored in the user's session
app.get("/profile", requireLogin, function(req, res) {
    const username = escapeHtml(req.session.user.username);

    res.send(responsePage(
        "Welcome to Your DegreePath Profile!",
        `
        <p>Hello, <strong>${username}</strong>!</p>

        <p>You are successfully logged in to DegreePath.</p>

        <p>
            Your username:
            <strong>${username}</strong>
        </p>

        <p>Your session is currently active.</p>

        <p>
            <a href="/dashboard">Go to Dashboard</a>
        </p>

        <p>
            <a href="/handbook">Upload Academic Handbook</a>
        </p>

        <p>
            <a href="/schedule">View Class Schedule</a>
        </p>

        <p>
            <a href="/logout">Logout</a>
        </p>
        `
    ));
});

// --------------------------------------------------
// LOGOUT
// --------------------------------------------------

// Destroy the session when the user clicks Logout
app.get("/logout", function(req, res) {
    req.session.destroy(function(err) {
        if (err) {
            console.error("Logout error:", err);

            return res.status(500).send(
                responsePage("Error logging out. Please try again.")
            );
        }

        // Remove the session cookie
        res.clearCookie("degreepath.sid", {
            path: "/"
        });

        // Display logout confirmation
        res.send(responsePage(
            "You Have Successfully Logged Out!",
            `
            <p>Your session has been destroyed.</p>

            <p>
                <a href="/login.html">Login Again</a>
            </p>
            `
        ));
    });
});

// --------------------------------------------------
// HANDBOOK API
// --------------------------------------------------

// All handbook API requests require an active login session
// Handles uploading, processing, reading, and deleting PDFs
app.use(
    "/api/handbooks",
    requireApiLogin,
    createHandbookRouter(db)
);

// --------------------------------------------------
// DEGREE PLANNER API
// --------------------------------------------------

// Protect academic planning data using the login session
app.use(
    "/api/planner",
    requireApiLogin,
    planner.router
);

// --------------------------------------------------
// CLASS SCHEDULE API
// --------------------------------------------------

// Save, import, view, and delete class meetings
app.use(
    "/api/schedule",
    requireApiLogin,
    schedule.router
);

// --------------------------------------------------
// CURRENT USER API
// --------------------------------------------------

// Return the logged-in user's username for the frontend
app.get("/api/user", requireApiLogin, function(req, res) {
    res.json({
        user_id: req.session.user.user_id,
        username: req.session.user.username
    });
});

// --------------------------------------------------
// ERROR HANDLING
// --------------------------------------------------

// Handle errors without revealing private database information
app.use(function(err, req, res, next) {
    console.error("Server error:", err);

    if (req.path.startsWith("/api/")) {
        return res.status(500).json({
            error: "Something went wrong. Please try again."
        });
    }

    res.status(500).send(
        responsePage("Something went wrong. Please try again.")
    );
});

// --------------------------------------------------
// DATABASE INITIALIZATION
// --------------------------------------------------

// Connect to MySQL and create the necessary tables
async function initializeDatabase() {
    try {
        // Verify the MySQL connection
        await db.query("SELECT 1");

        console.log("Database connection established!");

        // Create handbook_documents and handbook_pages tables
        // This does not delete the existing users table
        await initializeHandbookTables(db);

        // Create tables for onboarding choices and semester plans
        await planner.initializePlannerTables();

        // Create tables for class meetings and schedule uploads
        await schedule.initializeTables();

        console.log(
            "Handbook, planner, and schedule tables are ready!"
        );

        // Start the Express server after database setup
        app.listen(PORT, "0.0.0.0", function() {
            console.log(
                `DegreePath server running on port ${PORT}`
            );

            console.log(
                `Dashboard: http://localhost:${PORT}/dashboard`
            );

            console.log(
                `Handbook: http://localhost:${PORT}/handbook`
            );

            console.log(
                `Class schedule: http://localhost:${PORT}/schedule`
            );
        });

    } catch (err) {
        console.error(
            "Database initialization error:",
            err.message
        );

        process.exit(1);
    }
}

// Start DegreePath
initializeDatabase();

