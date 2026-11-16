-- Run once against degreepath_db. This preserves the existing users table and its rows.
USE degreepath_db;

CREATE TABLE IF NOT EXISTS degree_settings (
    user_id INT NOT NULL PRIMARY KEY,
    degree_name VARCHAR(140) NOT NULL DEFAULT 'Master of Science in Computer Science',
    target_credits INT NOT NULL DEFAULT 36,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS courses (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    code VARCHAR(24) NOT NULL,
    title VARCHAR(140) NOT NULL,
    credits DECIMAL(4,1) NOT NULL,
    semester VARCHAR(70) NOT NULL,
    status ENUM('planned','in_progress','completed') NOT NULL DEFAULT 'planned',
    grade VARCHAR(8) NOT NULL DEFAULT '',
    category VARCHAR(80) NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_courses_owner (user_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS requirements (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    name VARCHAR(100) NOT NULL,
    required_credits DECIMAL(5,1) NOT NULL,
    notes VARCHAR(500) NOT NULL DEFAULT '',
    INDEX idx_reqs_owner (user_id),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);
