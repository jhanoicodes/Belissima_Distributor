USE Belissima_Database;

CREATE TABLE usernotifications (
  id                INT NOT NULL AUTO_INCREMENT,
  userID            INT NOT NULL,
  notification_type VARCHAR(50) NOT NULL DEFAULT 'new_provider',
  provider_id       VARCHAR(25) NULL,
  is_read           TINYINT(1) NOT NULL DEFAULT 0,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  FOREIGN KEY (userID) REFERENCES Users(userID) ON DELETE CASCADE,
  INDEX idx_user_read (userID, is_read)
);