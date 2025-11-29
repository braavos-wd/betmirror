
import 'dotenv/config';
import mongoose from 'mongoose';
import { loadEnv } from '../config/env.js';
import readline from 'readline';

const env = loadEnv();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function wipe() {
  console.log('\n⚠️  DANGER ZONE: DATABASE WIPE ⚠️');
  console.log(`Target URI: ${env.mongoUri}`);
  
  if (env.mongoUri.includes('prod') || env.mongoUri.includes('production')) {
      console.error('❌ SAFETY LOCK: Cannot wipe a production database via this script.');
      process.exit(1);
  }

  rl.question('Are you sure you want to DROP the entire database? (type "delete"): ', async (answer) => {
    if (answer === 'delete') {
        try {
            await mongoose.connect(env.mongoUri);
            console.log('🔌 Connected. Dropping database...');
            
            await mongoose.connection.dropDatabase();
            
            console.log('✅ Database Wiped Successfully.');
            console.log('   - Users cleared');
            console.log('   - Trade History cleared');
            console.log('   - Registry cleared');
            
            await mongoose.disconnect();
            process.exit(0);
        } catch (e) {
            console.error(e);
            process.exit(1);
        }
    } else {
        console.log('🚫 Aborted.');
        process.exit(0);
    }
  });
}

wipe();
