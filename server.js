// server.js

// 1. КОНФІГУРАЦІЯ ТА ІМПОРТИ
require('dotenv').config();

const cors = require('cors'); 
const express = require('express');
const { ethers } = require('ethers');

// Використовуємо NeDB для простого збереження часу нагородження
const Datastore = require('nedb'); 

const app = express();
const port = 3000;

// === ІНІЦІАЛІЗАЦІЯ БАЗИ ДАНИХ ТА COOLDOWN ===
const db = new Datastore({ filename: 'cooldowns.db', autoload: true });

// Обмеження нагороди: 1 година (в мілісекундах)
const REWARD_COOLDOWN_MS = 1000 * 60 * 60 * 1; 

// 2. ВИКОРИСТОВУЄМО CORS та JSON
app.use(cors()); 
app.use(express.json()); 

// === КЛЮЧОВІ ДАНІ (ЧИТАЮТЬСЯ З .env) ===
// Використовуємо .trim() для видалення зайвих пробілів (що викликало попередню помилку)
const PRIVATE_KEY = process.env.PRIVATE_KEY.trim();
const CONTRACT_ADDRESS = '0x98065B24753198F4C9d543473510A8edaF438b56'; 

const CONTRACT_ABI = [
  {
    "type": "constructor",
    "inputs": [{"name": "initialOwner", "type": "address", "internalType": "address"}],
    "stateMutability": "nonpayable"
  },
  {
    "name": "mintReward",
    "type": "function",
    "inputs": [
      {"name": "to", "type": "address", "internalType": "address"},
      {"name": "amount", "type": "uint256", "internalType": "uint256"}
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "name": "balanceOf",
    "type": "function",
    "inputs": [{"name": "account", "type": "address", "internalType": "address"}],
    "outputs": [{"name": "", "type": "uint256", "internalType": "uint256"}],
    "stateMutability": "view"
  }
];

const RPC_URL = process.env.RPC_URL;

// === ІНІЦІАЛІЗАЦІЯ ETHERS ===
const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);
const tokenContract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);

// =========================================================================
//                  API ENDPOINT 1: ЗЧИТУВАННЯ БАЛАНСУ
// =========================================================================

app.get('/api/balance/:walletAddress', async (req, res) => {
    const playerWallet = req.params.walletAddress;

    if (!ethers.isAddress(playerWallet)) {
        return res.status(400).json({ message: 'Invalid player wallet address.' });
    }

    try {
        const balanceBigInt = await tokenContract.balanceOf(playerWallet);

        // ВИПРАВЛЕНО: Використовуємо 18 decimals для коректного відображення балансу
        const balance = ethers.formatUnits(balanceBigInt, 18); 
        
        console.log(`Checking balance for ${playerWallet}: ${balance} DOODLE`);

        res.json({
            success: true,
            balance: balance.toString()
        });

    } catch (error) {
        console.error('Error fetching balance:', error.message);
        res.status(500).json({ success: false, message: 'Could not fetch token balance.' });
    }
});

// =========================================================================
//                   API ENDPOINT 2: НАГОРОДЖЕННЯ З COOLDOWN
// =========================================================================

app.post('/api/reward', async (req, res) => {
    const { playerWallet, score } = req.body;
    
    // 1. Початкові перевірки
    if (!ethers.isAddress(playerWallet)) {
        return res.status(400).json({ message: 'Invalid player wallet address.' });
    }
    if (!score || score < 50) { 
        return res.status(400).json({ message: 'Invalid request or score too low (min 50 required).' });
    }

    // === 2. ПЕРЕВІРКА COOLDOWN ===
    const lastReward = await new Promise((resolve, reject) => {
        db.findOne({ wallet: playerWallet }, (err, doc) => {
            if (err) return reject(err);
            resolve(doc);
        });
    });

    const now = Date.now();
    
    if (lastReward) {
        const lastTime = lastReward.timestamp;
        const timeElapsed = now - lastTime;

        if (timeElapsed < REWARD_COOLDOWN_MS) {
            const timeLeftSeconds = Math.ceil((REWARD_COOLDOWN_MS - timeElapsed) / 1000);
            
            console.log(`Cooldown active for ${playerWallet}. Time left: ${timeLeftSeconds}s`);
            
            return res.status(429).json({ // 429: Too Many Requests
                success: false, 
                message: `Reward cooldown active. Try again in ${Math.ceil(timeLeftSeconds / 60)} minutes.`
            });
        }
    }
    // === КІНЕЦЬ ПЕРЕВІРКИ COOLDOWN ===


    try {
        const rewardAmount = 1;

        console.log(`Rewarding ${playerWallet} with ${rewardAmount} DOODLE for score ${score}...`);

        // 3. Відправка транзакції
        const tx = await tokenContract.mintReward(
            playerWallet, 
            rewardAmount
        );
        
        await tx.wait();

        // 4. ОНОВЛЕННЯ ЧАСУ В БАЗІ ДАНИХ (після успішної транзакції)
        db.update(
            { wallet: playerWallet },
            { wallet: playerWallet, timestamp: now },
            { upsert: true } // Створити, якщо не існує, оновити, якщо існує
        );

        console.log('Transaction confirmed:', tx.hash);

        res.json({
            success: true,
            message: `Successfully minted ${rewardAmount} DOODLE to ${playerWallet}`,
            txHash: tx.hash
        });

    } catch (error) {
        console.error('Error minting reward:', error.message);
        res.status(500).json({ success: false, message: 'Blockchain transaction failed. Check server logs.' });
    }
});


// === ЗАПУСК СЕРВЕРА ===
app.listen(port, () => {
    console.log('==============================================');
    console.log(`✅ Server listening at http://localhost:${port}`);
    console.log(`Contract Address: ${CONTRACT_ADDRESS}`);
    console.log('==============================================');
});