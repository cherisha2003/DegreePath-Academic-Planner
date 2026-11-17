# DegreePath — Academic Planner

**CSC 6370 — Web Programming | Georgia State University**

**Developed by:** Cherisha KG  
**Panther ID:** 002901729

## Project Overview

DegreePath is a full-stack academic planning website designed to help students organize their coursework, plan future semesters, track degree progress, and manage their academic schedules in one place.

The application combines course planning, degree requirements, and class scheduling through a personalized dashboard.

## Features

- **User Authentication:** Registration, login, logout, and session-based access to protected pages.
- **Course Management:** Create, view, update, and delete courses stored in MySQL.
- **Semester Planner:** Organize courses by semester and track completed, in-progress, and planned coursework.
- **Class Calendar:** Upload academic schedule PDFs to extract class information and organize weekly timetables.
- **Schedule Synchronization:** Connect imported class schedules with semester planning.
- **Course Catalog:** Browse and search Georgia State University CSC courses.
- **Handbook Management:** Upload academic handbooks and view degree requirements.
- **Degree Progress:** Track earned credits and review remaining requirements.
- **Program Comparison:** Compare different academic pathways, including course-only, project, and thesis options.

## Technologies Used

| Frontend | Backend | Database |
|---|---|---|
| HTML, CSS, JavaScript | Node.js, Express.js | MySQL |

Additional tools include Docker, Git, and GitHub.

## Running the Project Locally

**Prerequisites:** Node.js, npm, Docker Desktop, and MySQL.

1. Clone the repository:

   ```bash
   git clone https://github.com/cherisha2003/DegreePath-Academic-Planner.git
   cd DegreePath-Academic-Planner/backend
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Start the MySQL database and configure the application environment variables `DB_PASSWORD` and `SESSION_SECRET`. The application expects the `degreepath_db` database and `degreepath_app` MySQL user.

4. Start the application:

   ```bash
   npm start
   ```

5. Open `http://localhost:3000` in your browser.

## Security

DegreePath uses session-based authentication and protects user-specific database records. Unauthorized Create, Update, and Delete API requests return HTTP `401 Unauthorized`.

## Project Repository

https://github.com/cherisha2003/DegreePath-Academic-Planner

---

*DegreePath is an academic planning tool and does not replace official university degree evaluations or advisor approval.*
