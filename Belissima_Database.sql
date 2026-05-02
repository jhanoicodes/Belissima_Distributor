CREATE DATABASE Belissima_Database;
USE Belissima_Database;

CREATE TABLE Users (
    `userID` INT NOT NULL AUTO_INCREMENT, 
    `firstname` VARCHAR(35) NOT NULL, 
    `lastname` VARCHAR(35) NOT NULL, 
    `password` VARCHAR(255) NOT NULL, 
    `email` VARCHAR(100) NOT NULL, 
    `role` VARCHAR(60) NOT NULL DEFAULT 'user', 
    `security_code` VARCHAR(255) NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`userID`)) ENGINE = InnoDB AUTO_INCREMENT=1 DEFAULT CHARSET=utf8mb4;

CREATE TABLE Providers (
    `businessID` VARCHAR(25) UNIQUE NOT NULL,
    `parish` VARCHAR(70) NOT NULL,
    `service_type` VARCHAR(40) NOT NULL,
    `business_name` VARCHAR(255) NOT NULL,
    `phone_number` VARCHAR(20) NOT NULL,
    `other_contact` VARCHAR(50) NULL,
    `insta_link` VARCHAR(2048) NULL,
    `tiktok_link` VARCHAR(2048) NULL,
    `facebook_link` VARCHAR(2048) NULL,
    `booking_link` VARCHAR(2048) NULL,
    `other_booking` VARCHAR(50) NULL,
    `address` VARCHAR(255) NOT NULL,

    PRIMARY KEY (businessID),
    KEY idx_providers_type_parish(service_type, parish)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE Tags (
    `tagID` INT NOT NULL AUTO_INCREMENT,
    `businessID` VARCHAR(25) NOT NULL,

    `starting_price` DECIMAL(10,2) NULL,
    `board_certified` TINYINT(1) NULL,
    `company_allowed` TINYINT(1) NULL,
    `payment_methods` JSON NULL,
    `deposit_required` TINYINT(1) NOT NULL DEFAULT 0,
    `deposit_type` ENUM('fixed', 'percentage') NULL,
    `deposit_value` DECIMAL(10,2) NULL,
    `average_worktime` INT NULL,
    `walkins_allowed` TINYINT(1) NULL,
    `mobile_service` TINYINT(1) NULL,
    `provider_gender` ENUM('female', 'male') NULL,
    `kid_friendly` TINYINT(1) NULL,
    `disabled_friendly` TINYINT(1) NULL,
    
    `opening_hours` JSON NULL,
    `weekly_hours` DECIMAL(5,2) NULL,
    `days_open` TINYINT NULL,

    PRIMARY KEY (`tagID`),
    UNIQUE KEY `uq_tags_business`(`businessID`),
    CONSTRAINT `fk_tags_provider` FOREIGN KEY (`businessID`) REFERENCES Providers(`businessID`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO Users (firstname, lastname, email, password, role, security_code_hash) 
VALUES (
  'Jhanoi', 
  'Samuels', 
  'jhanoi@belissima.com', 
  '$2b$10$wOrh5IqoEdHa3J5b5rlYaO.BJo21sQ18Mt9Yy1OXVXPuWW6EdGcAi',  -- Hash of your admin password
  'admin', 
  '$2b$10$IVPQJJjHOqBkT7EHrSrakeX1lbDWapJXpRFJp1fQheqrU.0Lu36kW'  -- Hash of 'ADMIN123'
);

INSERT INTO Users (firstname, lastname, email, password, role, security_code_hash) 
VALUES (
  'Victoria', 
  'Whyte', 
  'victoria@belissima.com', 
  '$2b$10$rLdygSmFOJ7EM054QCdwkeS4UTk.lw9KPS/w6qIb/pp.Q3gdnM3L.',  -- Hash of your admin password
  'admin', 
  '$2b$10$TwTuCTuJ08pNaiAo6t0htOaWDONE1NfDVw2DxHmSpdcVpYl0m9SJK'  -- Hash of 'ADMIN123'
);

INSERT INTO Users (firstname, lastname, email, password, role, security_code_hash) 
VALUES (
  'Raeanna', 
  'Warren', 
  'raeanna@belissima.com', 
  '$2b$10$jJBd9OeVViJCCuxkX7RVgOuhgQ3jcpb9IOl.bDtfSV3L6SqaZmEaS',  -- Hash of your admin password
  'admin', 
  '$2b$10$KTJzG3L1AyXbmgw4ulUkHe0uNR85s/v1LUTwCDRswHu7p9v1toO1a'  -- Hash of 'ADMIN123'
);

INSERT INTO Users (firstname, lastname, email, password, role, security_code_hash) 
VALUES (
  'Alex', 
  'Campbell', 
  'alex@belissima.com', 
  '$2b$10$BD978O5sEfmeLO9iROLUD.6HiG4xkud9Wyqju3pJI.DLO.wHL0j4C',  -- Hash of your admin password
  'admin', 
  '$2b$10$bVhlVK/sZOLbqI2LcOdIPe6lxDM6fSEdCvHBuNcotJ0oqWvfBOw4K'  -- Hash of 'ADMIN123'
);

SELECT
  p.businessID,
  p.business_name,
  p.service_type,
  p.parish,
  t.starting_price,
  t.board_certified,
  t.company_allowed,
  t.payment_methods,
  t.average_worktime,
  t.disabled_friendly,
  t.kid_friendly,
  t.walkins_allowed,
  t.days_open,
  t.weekly_hours,
  (
    -- Price band scoring (map based on price_min or your stored band) and assigning points accordingly
    CASE
      WHEN t.starting_price BETWEEN 0 AND 2000 THEN 10
      WHEN t.starting_price BETWEEN 2001 AND 5000 THEN 8
      WHEN t.starting_price BETWEEN 5001 AND 9000 THEN 6
      WHEN t.starting_price >= 9001 THEN 3
      ELSE 0
    END
    +
    -- Checking for board certification and assigning points accordingly
    CASE 
      WHEN t.board_certified = 1 THEN 10
      WHEN t.board_certified = 0 THEN 5
      ELSE 0
    END
    +
    -- Checking if company is allowed and assigning points accordingly
    CASE 
        WHEN t.company_allowed = 1 THEN 3 ELSE 0 
    END
    +
    -- Checking the payment methods offered by each business and assigning points accordingly
    CASE
      WHEN t.payment_methods IS NULL THEN 0
      WHEN JSON_LENGTH(t.payment_methods) >= 2 THEN 9
      ELSE
        (CASE WHEN JSON_CONTAINS(t.payment_methods, JSON_QUOTE('cash')) THEN 3 ELSE 0 END) +
        (CASE WHEN JSON_CONTAINS (t.payment_methods, JSON_QUOTE('card')) THEN 3 ELSE 0 END) +
        (CASE WHEN JSON_CONTAINS (t.payment_methods, JSON_QUOTE('transfer'))THEN 3 ELSE 0 END)
    END
    +
    -- Average work time (how long the provider takes to do their services) and assigning points accordingly
    CASE
      When t.average_worktime IS NULL THEN 0
      WHEN t.average_worktime <= 60 THEN 10
      WHEN t.average_worktime  <= 120 THEN 8
      WHEN t.average_worktime  <= 180 THEN 6
      WHEN t.average_worktime  > 180 THEN 3
      ELSE 0
    END
    +
    -- Checking if the business is disabled friendly and assigning points accordingly
    CASE 
        WHEN t.disabled_friendly = 1 THEN 6 
        ELSE 0 
    END
    +
    -- Checking if the business is kid friendly and assigning points accordingly
    CASE 
        WHEN t.kid_friendly = 1 THEN 6 
        ELSE 0 
    END
    
    +
    -- Checking if walk-ins are allowed and assigning points accordingly
    CASE WHEN t.walkins_allowed = TRUE THEN 6 ELSE 0 END
    +
    -- Scoring the number of days the business is open
    CASE
      WHEN t.days_open IS NULL THEN 0
      WHEN t.days_open = 3 THEN 2
      WHEN t.days_open = 4 THEN 4
      WHEN t.days_open = 5 THEN 6
      WHEN t.days_open = 6 THEN 8
      WHEN t.days_open >= 7 THEN 10
      ELSE 0
    END
    +
    -- Checking the weekly hours provided and assigning points accordingly
    CASE
      WHEN t.weekly_hours IS NULL THEN 0
      WHEN t.weekly_hours >= 63 THEN 6      -- ~9hrs/day * 7days
      WHEN t.weekly_hours >= 49 THEN 4      -- ~7hrs/day * 7days
      WHEN t.weekly_hours >= 28 THEN 2
      ELSE 0
    END
    
  ) AS score
FROM Providers p
JOIN Tags t ON t.businessID = p.businessID
WHERE
  p.service_type = 'NAIL ARTIST'          -- e.g. 'nail_artist'
  AND p.parish = 'Portmore'    -- eg. 'portmore'
 
ORDER BY score DESC
LIMIT 5;

