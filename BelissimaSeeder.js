require('dotenv').config();
const mysql = require('mysql2/promise');
const fs = require('fs');

// Load your JSON data
const providersData = JSON.parse(fs.readFileSync('BelissimaPopulator.json', 'utf8'));

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'Belissima_Database',
  waitForConnections: true,
  connectionLimit: 10,
});

async function repopulateDatabase() {
  let connection;

  try {
    connection = await pool.getConnection();

    // Start transaction
    await connection.beginTransaction();

    // Clear existing data
    console.log('🗑️  Clearing existing data...');
    await connection.execute('SET FOREIGN_KEY_CHECKS = 0');
    await connection.execute('TRUNCATE TABLE Tags');
    await connection.execute('TRUNCATE TABLE Providers');
    await connection.execute('TRUNCATE TABLE ProviderRequests');
    await connection.execute('SET FOREIGN_KEY_CHECKS = 1');

    console.log(`📥 Inserting ${providersData.length} providers...`);

    let successCount = 0;
    let errorCount = 0;

    for (const provider of providersData) {
      try {
        // Insert into Providers table
        await connection.execute(`
          INSERT INTO Providers (
            businessID, parish, service_type, business_name, 
            phone_number, other_contact, insta_link, tiktok_link, 
            facebook_link, booking_link, other_booking, address
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          provider.businessID,
          provider.parish,
          provider.service_type,
          provider.business_name,
          provider.phone_number || null,
          provider.other_contact || null,
          provider.insta_link || null,
          provider.tiktok_link || null,
          provider.facebook_link || null,
          provider.booking_link || null,
          provider.other_booking || null,
          provider.address || null
        ]);

        // Parse payment methods
        let paymentMethods = null;
        if (provider.payment_methods && provider.payment_methods !== 'NA') {
          const methods = provider.payment_methods.split(',').map(m => m.trim().toLowerCase());
          paymentMethods = JSON.stringify(methods);
        }

        // Parse starting price (remove $ and 'up', convert to number)
        let startingPrice = null;
        if (provider.starting_price && provider.starting_price !== 'NA') {
          const priceStr = provider.starting_price.replace('$', '').replace(' USD', '').replace(' up', '').replace(',', '').trim();
          startingPrice = parseFloat(priceStr);
        }

        // Parse average work time (convert to minutes)
        let avgWorkTime = null;
        if (provider.average_worktime && provider.average_worktime !== 'NA') {
          const timeStr = provider.average_worktime.toLowerCase();
          if (timeStr.includes('hour')) {
            let hours = 0, minutes = 0;
            const hourMatch = timeStr.match(/(\d+)\s*hours?/);
            const minMatch = timeStr.match(/(\d+)\s*mins?/);
            if (hourMatch) hours = parseInt(hourMatch[1]);
            if (minMatch) minutes = parseInt(minMatch[1]);
            avgWorkTime = (hours * 60) + minutes;
          } else if (timeStr.includes('min')) {
            avgWorkTime = parseInt(timeStr);
          }
        }

        // Map yes/no/not sure to boolean
        function mapBoolean(value) {
          if (value === 'Yes') return 1;
          if (value === 'No') return 0;
          if (value === 'Not sure') return 0;
          return 0;
        }

        await connection.execute(`
          INSERT INTO Tags (
            businessID, starting_price, board_certified, company_allowed,
            payment_methods, deposit_required, deposit_type, deposit_value,
            average_worktime, walkins_allowed, mobile_service, provider_gender,
            kid_friendly, disabled_friendly, opening_hours, days_open, weekly_hours
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          provider.businessID,
          startingPrice,
          mapBoolean(provider.board_certified),
          mapBoolean(provider.company_allowed),
          paymentMethods,
          mapBoolean(provider.deposit_required) ?? 0,
          provider.deposit_type === 'percentage' ? 'percentage' : provider.deposit_type === 'fixed' ? 'fixed' : null,
          provider.deposit_amount ? parseFloat(provider.deposit_amount) : null,
          avgWorkTime,
          mapBoolean(provider.walkins_allowed) ?? 0,
          mapBoolean(provider.mobile_service) ?? 0,
          provider.provider_gender === 'Female' ? 'female' : provider.provider_gender === 'Male' ? 'male' : null,
          mapBoolean(provider.kid_friendly) ?? 0,
          mapBoolean(provider.disabled_friendly) ?? 0,
          provider.opening_hours ? JSON.stringify(provider.opening_hours) : null,
          provider.days_open ?? null,
          provider.weekly_hours ?? null
        ]);

        successCount++;
        console.log(`✅ ${successCount}. ${provider.business_name}`);

      } catch (err) {
        errorCount++;
        console.error(`❌ Error inserting ${provider.business_name}:`, err.message);
      }
    }

    // Commit transaction AFTER the loop (not inside it)
    await connection.commit();

    console.log(`\n🎉 Repopulation complete!`);
    console.log(`   ✅ Success: ${successCount}`);
    console.log(`   ❌ Errors: ${errorCount}`);

    // Verify counts
    const [providerCount] = await connection.execute('SELECT COUNT(*) as count FROM Providers');
    const [tagsCount] = await connection.execute('SELECT COUNT(*) as count FROM Tags');
    console.log(`\n📊 Database now has:`);
    console.log(`   Providers: ${providerCount[0].count}`);
    console.log(`   Tags: ${tagsCount[0].count}`);

  } catch (err) {
    console.error('❌ Database error:', err.message);
    if (connection) await connection.rollback();
  } finally {
    if (connection) connection.release();
    await pool.end();
  }
}

// Run the repopulation
repopulateDatabase();