// server.js

// 1. КОНФІГУРАЦІЯ ТА ІМПОРТИ
require('dotenv').config();

const cors = require('cors'); 
const express = require('express');
const { ethers } = require('ethers');

// Використовуємо Nedb для CoolDown та Рефералів
const Datastore = require('nedb'); 

const app = express();
const port = 3000;

// === ІНІЦІАЛІЗАЦІЯ БАЗИ ДАНИХ ТА COOLDOWN ===
const cooldownDB = new Datastore({ filename: 'cooldowns.db', autoload: true }); // Для ліміту часу
const referralDB = new Datastore({ filename: 'referrals.db', autoload: true }); // Для реферальних зв'язків

// Обмеження нагороди: 1 година (в мілісекундах)
const REWARD_COOLDOWN_MS = 1000 * 60 * 60 * 1; 

// Параметри економіки
const SCORE_THRESHOLD = 50;
const REWARD_AMOUNT = 1;
const REFERRAL_BONUS_PERCENT = 0.1; // 10% бонусу

app.use(cors()); 
app.use(express.json()); 

// === КЛЮЧОВІ ДАНІ ===
const PRIVATE_KEY = process.env.PRIVATE_KEY ? process.env.PRIVATE_KEY.trim() : null;
const CONTRACT_ADDRESS = '0x98065B24753198F4C9d543473510A8edaF438b56'; 
const CONTRACT_ABI = [
  // ... (Ваші ABI)
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

if (!PRIVATE_KEY) {
    console.error("FATAL ERROR: PRIVATE_KEY is not set in Environment Variables!");
    process.exit(1); 
}

const RPC_URL = process.env.RPC_URL;
const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);
const tokenContract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);


// =========================================================================
//                  API ENDPOINT 1: ЗЧИТУВАННЯ БАЛАНСУ
// =========================================================================

app.get('/api/balance/:walletAddress', async (req, res) => {
    const playerWallet = req.params.walletAddress;
    // ... (той самий код для перевірки балансу)
    if (!ethers.isAddress(playerWallet)) {
        return res.status(400).json({ message: 'Invalid player wallet address.' });
    }

    try {
        const balanceBigInt = await tokenContract.balanceOf(playerWallet);
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


// ========================================================
//          API ENDPOINT 2: ЗВ'ЯЗУВАННЯ РЕФЕРАЛА
// ========================================================
app.post('/api/link-referrer', async (req, res) => {
    const { referralWallet, referrerCode } = req.body;

    if (!referralWallet || !referrerCode) {
        return res.status(400).send({ message: "Referral wallet and referrer code are required." });
    }

    // Реферальний код - це останні 8 символів гаманця реферера
    // Ми припускаємо, що код має бути розширений до повної адреси 0x...
    const referrerWallet = '0x' + referrerCode;

    if (referralWallet.toLowerCase() === referrerWallet.toLowerCase()) {
         return res.status(400).send({ message: "Cannot refer yourself." });
    }

    // Перевіряємо, чи цей гравець вже не має реферера
    referralDB.findOne({ referralWallet }, (err, doc) => {
        if (err) return res.status(500).send({ message: "Database error." });
        
        if (doc) {
            return res.status(200).send({ message: "Referrer already linked." });
        }

        // Зберігаємо новий зв'язок
        referralDB.insert({ referralWallet, referrerWallet, linkedAt: new Date() }, (err, newDoc) => {
            if (err) return res.status(500).send({ message: "Database error on insert." });
            console.log(`New referral link: ${referralWallet} linked by ${referrerWallet}`);
            res.status(200).send({ message: "Referrer linked successfully." });
        });
    });
});


// =========================================================================
//          API ENDPOINT 3: НАГОРОДЖЕННЯ З COOLDOWN ТА РЕФЕРАЛОМ
// =========================================================================

app.post('/api/reward', async (req, res) => {
    const { playerWallet, score } = req.body;
    
    // 1. Початкові перевірки
    if (!ethers.isAddress(playerWallet)) {
        return res.status(400).json({ message: 'Invalid player wallet address.' });
    }
    if (!score || score < SCORE_THRESHOLD) { 
        return res.status(400).json({ message: `Score too low (min ${SCORE_THRESHOLD} required).` });
    }

    // === 2. ПЕРЕВІРКА COOLDOWN ===
    const lastReward = await new Promise((resolve, reject) => {
        cooldownDB.findOne({ wallet: playerWallet }, (err, doc) => {
            if (err) return reject(err);
            resolve(doc);
        });
    });

    const now = Date.now();
    
    if (lastReward) {
        const timeElapsed = now - lastReward.timestamp;

        if (timeElapsed < REWARD_COOLDOWN_MS) {
            const timeLeftSeconds = Math.ceil((REWARD_COOLDOWN_MS - timeElapsed) / 1000);
            return res.status(429).json({ 
                success: false, 
                message: `Reward cooldown active. Try again in ${Math.ceil(timeLeftSeconds / 60)} minutes.`
            });
        }
    }
    // === КІНЕЦЬ ПЕРЕВІРКИ COOLDOWN ===


    try {
        let response = { success: true, message: 'Reward processed.', awardedToReferral: REWARD_AMOUNT };

        // 3. Карбування ОСНОВНОЇ нагороди
        const rewardTx = await tokenContract.mintReward(
            playerWallet, 
            ethers.parseUnits(REWARD_AMOUNT.toString(), 18) // Конвертуємо в BigInt з 18 decimals
        );
        await rewardTx.wait();
        response.rewardTxHash = rewardTx.hash;

        // 4. ОНОВЛЕННЯ ЧАСУ В БАЗІ ДАНИХ (після успішної транзакції)
        cooldownDB.update(
            { wallet: playerWallet },
            { wallet: playerWallet, timestamp: now },
            { upsert: true }
        );

        // 5. ПЕРЕВІРКА ТА КАРБУВАННЯ РЕФЕРАЛЬНОГО БОНУСУ
        referralDB.findOne({ referralWallet: playerWallet }, async (err, doc) => {
            if (doc && !err) {
                const { referrerWallet } = doc;
                const bonusAmount = REWARD_AMOUNT * REFERRAL_BONUS_PERCENT;
                
                try {
                    // Карбування бонусу для реферера
                    const bonusTx = await tokenContract.mintReward(
                        referrerWallet, 
                        ethers.parseUnits(bonusAmount.toString(), 18)
                    );
                    await bonusTx.wait();
                    
                    console.log(`Referral Bonus: ${bonusAmount} DOODLE sent to ${referrerWallet}`);
                    
                    response.awardedToReferrer = bonusAmount;
                    response.bonusTxHash = bonusTx.hash;

                } catch (bonusError) {
                    console.error('Error minting referral bonus:', bonusError.message);
                    // Не повертаємо помилку 500, оскільки основна нагорода вже пройшла
                }
            }
            
            // Відправка відповіді після всіх асинхронних операцій
            res.json(response); 
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