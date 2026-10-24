
const express = require("express");
const mysql = require("mysql2");
const crypto = require("crypto");

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const db = mysql.createConnection({
    host: "127.0.0.1",
    user: "degreepath_app",
    password: process.env.DB_PASSWORD,
    database: "degreepath_db",
    port: 3306
});

// Turn plain passwords into hashes before storing them
function hashPassword(password, salt) {
    return crypto.pbkdf2Sync(
        password, salt, 210000, 64, "sha512"
    ).toString("hex");
}

// Display a simple response with navigation links
function responsePage(message) {
    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <title>DegreePath</title>
            <link rel="stylesheet" href="/style.css">
        </head>
        <body>
            <main class="container">
                <h1>DegreePath</h1>
                <h2>${message}</h2>
                <p><a href="/login.html">Back to Login</a></p>
                <p><a href="/register.html">Register</a></p>
            </main>
        </body>
        </html>
    `;
}

// Register a new user
app.post("/register", function(req, res) {
    const username = (req.body.username || "").trim();
    const email = (req.body.email || "").trim();
    const password = req.body.password || "";

    if (!username || !email || password.length < 8) {
        return res.status(400).send(
            responsePage("Please enter valid registration details.")
        );
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = hashPassword(password, salt);

    const sql = `
        INSERT INTO users
        (username, email, password_hash, password_salt, first_name, last_name)
        VALUES (?, ?, ?, ?, ?, ?)
    `;

    db.query(
        sql,
        [username, email, passwordHash, salt, username, ""],
        function(err, result) {
            if (err) {
                if (err.code === "ER_DUP_ENTRY") {
                    return res.status(409).send(
                        responsePage("Username or email already exists.")
                    );
                }

                console.error("Registration error:", err);
                return res.status(500).send(
                    responsePage("Registration failed. Please try again.")
                );
            }

            res.send(responsePage("You have successfully registered"));
        }
    );
});

// Check username and password when logging in
app.post("/login", function(req, res) {
    const username = req.body.username || "";
    const password = req.body.password || "";

    const sql = `
        SELECT password_hash, password_salt
        FROM users
        WHERE username = ?
    `;

    db.query(sql, [username], function(err, results) {
        if (err) {
            console.error("Login error:", err);
            return res.status(500).send(
                responsePage("Something went wrong. Please try again.")
            );
        }

        if (results.length === 0 || !results[0].password_hash) {
            return res.status(401).send(
                responsePage("The login credentials were incorrect")
            );
        }

        const user = results[0];
        const enteredHash = Buffer.from(
            hashPassword(password, user.password_salt), "hex"
        );
        const savedHash = Buffer.from(user.password_hash, "hex");

        const validPassword =
            enteredHash.length === savedHash.length &&
            crypto.timingSafeEqual(enteredHash, savedHash);

        if (validPassword) {
            res.send(responsePage("You have logged in successfully"));
        } else {
            res.status(401).send(
                responsePage("The login credentials were incorrect")
            );
        }
    });
});

// Start only after confirming the database connection
db.connect(function(err) {
    if (err) {
        console.error("Could not connect to MySQL:", err.message);
        process.exit(1);
    }

    console.log("Database connection established!");

    app.listen(3000, "0.0.0.0", function() {
        console.log("DegreePath server running on port 3000");
    });
});
