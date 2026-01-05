require("dotenv").config();
const { AttachmentBuilder } = require("discord.js");
const { Client, GatewayIntentBits, Partials, Events } = require("discord.js");
const fs = require("fs");
const path = require("path");

// ====== CONFIG ======
const PREFIX = "!";
const DATA_FILE = path.join(__dirname, "bank-data.json");
// ====================

const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildBans,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

let busy = false;

// ============= DATA STORAGE =============

let bankData = {
  // accounts keyed by name string
  balances: {}, // { [name: string]: number }
  transactions: {}, // { [name: string]: [ { timestamp, type, amount, actorId, note } ] }

  // default name per Discord user
  profiles: {}, // { [discordUserId: string]: { name: string } }

  // loans keyed by loanId
  loans: {}, // { timestamp, borrowerName, lenderName, balance, status, actorId, note }
  loanTransactions: {}, // { [loanId: string]: [ { timestamp, type, amount, actorId, note } ] }s
};

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      bankData = JSON.parse(raw);

      // backward compatibility / safety
      if (!bankData.balances) bankData.balances = {};
      if (!bankData.transactions) bankData.transactions = {};
      if (!bankData.profiles) bankData.profiles = {};
      if (!bankData.loans) bankData.loans = {};
      if (!bankData.loanTransactions) bankData.loanTransactions = {};
    }
  } catch (err) {
    console.error("Failed to load bank data:", err);
  }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(bankData, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to save bank data:", err);
  }
}

function getBalance(accountName) {
  return bankData.balances[accountName] || 0;
}

function setBalance(accountName, amount) {
  bankData.balances[accountName] = amount;
}

function recordTransaction(accountName, type, amount, actorId, note) {
  if (!bankData.transactions[accountName]) {
    bankData.transactions[accountName] = [];
  }
  bankData.transactions[accountName].push({
    timestamp: new Date().toISOString(),
    type, // "deposit" | "withdraw"
    amount,
    actorId,
    note: note || "",
  });
}

function normalizeLoanId(id) {
  if (!id) return null;
  id = String(id).trim();
  if (!id.length) return null;
  return id.substring(0, 64);
}

function getLoan(loanId) {
  return bankData.loans[loanId] || null;
}

function ensureLoanTxList(loanId) {
  if (!bankData.loanTransactions[loanId]) {
    bankData.loanTransactions[loanId] = [];
  }
  return bankData.loanTransactions[loanId];
}

function recordLoanTransaction(loanId, type, amount, actorId, note) {
  ensureLoanTxList(loanId).push({
    timestamp: new Date().toISOString(),
    type, // "loan" | "repay" | "accrue" | "resolve"
    amount,
    actorId,
    note: note || "",
  });
}

function isLoanId(str) {
  const id = normalizeLoanId(str);
  if (!id) return false;
  return !!bankData.loans[id] || !!bankData.loanTransactions[id];
}

function getTopGpEntries(limit) {
  return Object.entries(bankData.balances || {})
    .map(([name, bal]) => [String(name), Number(bal) || 0])
    .filter(([, bal]) => Number.isFinite(bal) && bal > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function getTopDebtEntries(limit) {
  const debtByBorrower = {}; // { [borrowerName]: { debt: number } }

  for (const [, loan] of Object.entries(bankData.loans || {})) {
    if (!loan) continue;
    if (loan.status === "resolved") continue;

    const bal = Number(loan.balance) || 0;
    if (!Number.isFinite(bal) || bal <= 0) continue;

    const borrowerName = loan.borrowerName || "Unknown";

    if (!debtByBorrower[borrowerName]) {
      debtByBorrower[borrowerName] = { debt: 0 };
    }
    debtByBorrower[borrowerName].debt += bal;
  }

  return Object.values(debtByBorrower)
    .filter((v) => Number.isFinite(v.debt) && v.debt > 0)
    .sort((a, b) => b.debt - a.debt)
    .slice(0, limit);
}

// ============= NAME PROFILES =============

function getDefaultNameForUser(user) {
  const profile = bankData.profiles[user.id];
  return profile && profile.name ? profile.name : user.username;
}

function setDefaultNameForUser(user, name) {
  if (!bankData.profiles[user.id]) {
    bankData.profiles[user.id] = {};
  }
  name = name.split(" ")[0].substr(0, 32);
  bankData.profiles[user.id].name = name.trim();
}

// resolve account name from argument or mention, else caller default
function resolveAccountName(message, firstArg) {
  if (message.mentions.users.size > 0) {
    const targetUser = message.mentions.users.first();
    return getDefaultNameForUser(targetUser);
  }
  if (firstArg) return firstArg;
  return getDefaultNameForUser(message.author);
}

// For loan commands we need BOTH id and name when possible
function resolvePersonFromArgOrMention(message, arg) {
  if (message.mentions.users.size > 0) {
    const u = message.mentions.users.first();
    return { id: u.id, name: getDefaultNameForUser(u), fromMention: true };
  }
  if (arg) return { id: null, name: String(arg).trim(), fromMention: false };
  return { id: message.author.id, name: getDefaultNameForUser(message.author), fromMention: false };
}

// ============= UTILS =============

function parseAmount(str) {
  if (!str) return null;
  const n = Number(str);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function eqName(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

function generateLoanId(borrowerName, lenderName) {
  const base = `loan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const safe = normalizeLoanId(base) || `loan_${Date.now()}`;
  // keep a small hint in note fields; id should be opaque & unique
  return safe;
}

function findOpenLoans(borrowerName, lenderName) {
  return Object.entries(bankData.loans || {})
    .filter(([, loan]) => loan && loan.status !== "resolved")
    .filter(([, loan]) => {
      const borrowerMatch = eqName(loan.borrowerName, borrowerName);
      const lenderMatch = eqName(loan.lenderName, lenderName);
      return borrowerMatch && lenderMatch;
    })
    .map(([, loan]) => loan);
}


// ============= COMMAND HANDLING =============

client.on("ready", () => {
  console.log("Bank bot ready");
  loadData();
});

client.on(Events.MessageCreate, (receivedMessage) => {
  if (receivedMessage.author.bot) return;
  if (!receivedMessage.content.startsWith(PREFIX)) return;

  processCommand(receivedMessage).catch((err) => {
    console.error("Error in command:", err);
    receivedMessage.channel.send("Something went wrong processing that command.");
    busy = false;
  });
});

async function processCommand(receivedMessage) {
  const fullCommand = receivedMessage.content.slice(PREFIX.length).trim();
  if (!fullCommand.length) return;

  const splitCommand = fullCommand.split(/\s+/);
  const primaryCommand = splitCommand[0].toLowerCase();
  const args = splitCommand.slice(1);

  console.log("Command received:", primaryCommand, "Args:", args.join(" "));

  if (primaryCommand === "help") return helpCommand(receivedMessage);
  if (primaryCommand === "exportdb") return exportDbCommand(receivedMessage);
  if (primaryCommand === "setname") return setNameCommand(receivedMessage, args);

  if (["deposit", "withdraw"].includes(primaryCommand)) {
    if (busy) return receivedMessage.channel.send("Busy processing another transaction, try again in a moment.");
    busy = true;
    try {
      if (primaryCommand === "deposit") await depositCommand(receivedMessage, args);
      else await withdrawCommand(receivedMessage, args);
      saveData();
    } finally {
      busy = false;
    }
    return;
  }

  if (primaryCommand === "balance") return balanceCommand(receivedMessage, args);

  if (["loan", "repay", "accrue"].includes(primaryCommand)) {
    if (busy) return receivedMessage.channel.send("Busy processing another transaction, try again in a moment.");
    busy = true;
    try {
      if (primaryCommand === "loan") await loanCommand(receivedMessage, args);
      else if (primaryCommand === "repay") await repayCommand(receivedMessage, args);
      else await accrueCommand(receivedMessage, args);
      saveData();
    } finally {
      busy = false;
    }
    return;
  }

  if (primaryCommand === "debt") return debtCommand(receivedMessage, args);
  if (primaryCommand === "debtors") return debtorsCommand(receivedMessage, args);
  if (primaryCommand === "history") return historyCommand(receivedMessage, args);
  if (primaryCommand === "leaderboard") return leaderboardCommand(receivedMessage, args);

  receivedMessage.channel.send("Unknown command. Try `!help`.");
}

// ============= COMMANDS =============

function helpCommand(message) {
  const text = [
    "**Bank Bot Commands**",
    "`!setname <name>` - Set your default bank account name.",
    "`!deposit <amount> [note...]` - Add GP to your balance.",
    "`!deposit <@user|name> <amount> [note...]` - Add GP to someone else's balance.",
    "`!withdraw <amount> [note...]` - Remove GP from your balance.",
    "`!withdraw <@user|name> <amount> [note...]` - Remove GP from someone else's balance.",
    "`!balance` - Show your balance.",
    "`!balance <@user|name>` - Show someone else's balance.",
    "",
    "**Loans (separate from bank balance)**",
    "`!loan <amount> <lender> [note...]` - Create a loan for you (borrower = you).",
    "`!loan <@user|name> <amount> <lender> [note...]` - Create a loan for a borrower.",
    "`!repay <amount> <lender|loan_id>` - Repay part/all of your loan to that lender.",
    "`!repay <@user|name> <amount> <lender|loan_id>` - Repay part/all of a borrower's loan.",
    "`!accrue <amount> <lender|loan_id>` - Add interest/fees to your loan to that lender.",
    "`!accrue <@user|name> <amount> <lender|loan_id>` - Add interest/fees to a borrower's loan.",
    "`!debt <@user|name>` - List unresolved loans of a borrower.",
    "`!debtors <@user|name>` - List unresolved loans where that person is the lender.",
    "",
    "`!history <count>` - Show your recent bank transactions.",
    "`!history <@user|name> <count>` - Show recent bank transactions for an account name/user.",
    "`!leaderboard <count>` - Show leaderboards (max 10).",
    "`!exportdb` - Export the current JSON database file (admin / trusted use).",
    "",
    "Examples:",
    "`!setname Malakai`",
    "`!deposit 300 Session 3 rewards`",
    "`!deposit Vani 300 Session 3 rewards`",
    "`!withdraw 50 Bought potions`",
    "`!withdraw Vani 50 Bought potions`",
    "`!balance`",
    "`!balance Vani`",
    "`!loan 100 Vixil`",
    "`!loan Vani 100 Vixil Tuning cost`",
    "`!repay 50 Vixil`",
    "`!accrue 10 Vixil`",
    "`!debt Malakai`",
    "`!debtors Vixil`",
    "`!history 10`",
    "`!history Vani 10`",
    "`!leaderboard 10`",
  ].join("\n");

  message.channel.send(text);
}

function exportDbCommand(message) {
  // !exportdb
  try {
    if (!fs.existsSync(DATA_FILE)) return message.channel.send("Database file not found.");

    const file = new AttachmentBuilder(DATA_FILE, { name: "bank-data.json" });
    return message.channel.send({
      content: "Here is the current database file:",
      files: [file],
    });
  } catch (err) {
    console.error("Failed to export database:", err);
    return message.channel.send("Could not export the database.");
  }
}

function setNameCommand(message, args) {
  // !setname <name>
  if (!args.length) return message.channel.send("Usage: `!setname <name>`");

  const name = args.join(" ").trim();
  if (!name.length) return message.channel.send("Name cannot be empty.");
  if (name.length > 32) return message.channel.send("Name is too long (max 32 characters).");

  setDefaultNameForUser(message.author, name);
  saveData();
  message.channel.send(`Your default bank name is now **${name}**.`);
}

async function depositCommand(message, args) {
  // !deposit <amount> [note...]
  // !deposit <@user|name> <amount> [note...]
  if (args.length < 2) {
    return message.channel.send("Usage:\n`!deposit <amount> [note...]`\n`!deposit <@user|name> <amount> [note...]`");
  }

  let accountName;
  let amountArg;
  let noteArgs;

  const firstIsNumber = Number.isFinite(Number(args[0])) && !message.mentions.users.size;

  if (firstIsNumber) {
    accountName = getDefaultNameForUser(message.author);
    amountArg = args[0];
    noteArgs = args.slice(1);
  } else {
    if (args.length < 3) {
      return message.channel.send("Usage:\n`!deposit <amount> [note...]`\n`!deposit <@user|name> <amount> [note...]`");
    }
    accountName = resolveAccountName(message, args[0]);
    amountArg = args[1];
    noteArgs = args.slice(2);
  }

  const amount = parseAmount(amountArg);
  if (amount === null) return message.channel.send("Amount must be a positive number.");

  const note = noteArgs.join(" ");
  const oldBalance = getBalance(accountName);
  const newBalance = oldBalance + amount;

  setBalance(accountName, newBalance);
  recordTransaction(accountName, "deposit", amount, message.author.id, note);

  message.channel.send(
    `Deposited **${amount} GP** to **${accountName}**.\nNew balance: **${newBalance} GP** (was ${oldBalance} GP).`
  );
}

async function withdrawCommand(message, args) {
  // !withdraw <amount> [note...]
  // !withdraw <@user|name> <amount> [note...]
  if (args.length < 2) {
    return message.channel.send("Usage:\n`!withdraw <amount> [note...]`\n`!withdraw <@user|name> <amount> [note...]`");
  }

  let accountName;
  let amountArg;
  let noteArgs;

  const firstIsNumber = Number.isFinite(Number(args[0])) && !message.mentions.users.size;

  if (firstIsNumber) {
    accountName = getDefaultNameForUser(message.author);
    amountArg = args[0];
    noteArgs = args.slice(1);
  } else {
    if (args.length < 3) {
      return message.channel.send("Usage:\n`!withdraw <amount> [note...]`\n`!withdraw <@user|name> <amount> [note...]`");
    }
    accountName = resolveAccountName(message, args[0]);
    amountArg = args[1];
    noteArgs = args.slice(2);
  }

  const amount = parseAmount(amountArg);
  if (amount === null) return message.channel.send("Amount must be a positive number.");

  const oldBalance = getBalance(accountName);
  if (amount > oldBalance) {
    return message.channel.send(`Cannot withdraw **${amount} GP** from **${accountName}**; it only has **${oldBalance} GP**.`);
  }

  const note = noteArgs.join(" ");
  const newBalance = oldBalance - amount;

  setBalance(accountName, newBalance);
  recordTransaction(accountName, "withdraw", amount, message.author.id, note);

  message.channel.send(
    `Withdrew **${amount} GP** from **${accountName}**.\nNew balance: **${newBalance} GP** (was ${oldBalance} GP).`
  );
}

function balanceCommand(message, args) {
  // !balance
  // !balance <@user|name>
  const accountName = resolveAccountName(message, args[0]);
  const balance = getBalance(accountName);
  message.channel.send(`Balance for **${accountName}**: **${balance} GP**.`);
}

function historyCommand(message, args) {
  // !history
  // !history <count>
  // !history <@user|name>
  // !history <@user|name> <count>
  let accountName = getDefaultNameForUser(message.author);
  let count = 5;

  if (args.length === 0) {
    accountName = getDefaultNameForUser(message.author);
  } else {
    const firstIsNumber = Number.isFinite(Number(args[0])) && !message.mentions.users.size;

    if (firstIsNumber) {
      const n = Number(args[0]);
      if (n > 0 && n <= 20) count = Math.floor(n);
      accountName = getDefaultNameForUser(message.author);
    } else {
      accountName = resolveAccountName(message, args[0]);
      if (args[1]) {
        const n = Number(args[1]);
        if (Number.isFinite(n) && n > 0 && n <= 20) count = Math.floor(n);
      }
    }
  }

  const list = bankData.transactions[accountName] || [];
  if (list.length === 0) return message.channel.send(`No transactions for **${accountName}** yet.`);

  const recent = list.slice(-count);
  const lines = recent.map((t) => {
    const date = new Date(t.timestamp).toLocaleString();
    const sign = t.type === "deposit" ? "+" : "-";
    const actor = `<@${t.actorId}>`;
    const note = t.note ? ` - ${t.note}` : "";
    return `\`${date}\` ${sign}${t.amount} GP by ${actor}${note}`;
  });

  message.channel.send(`Last ${recent.length} transaction(s) for **${accountName}**:\n` + lines.join("\n"));
}

async function loanCommand(message, args) {
  // !loan <amount> <lender> [note...]
  // !loan <@user|name> <amount> <lender> [note...]
  if (args.length < 3) {
    return message.channel.send(
      "Usage:\n`!loan <amount> <lender> [note...]`\n`!loan <@user|name> <amount> <lender> [note...]`"
    );
  }

  let borrower;
  let amountArg;
  let lenderArg;
  let noteArgs;

  const firstIsNumber = Number.isFinite(Number(args[0])) && !message.mentions.users.size;

  if (firstIsNumber) {
    borrower = { id: message.author.id, name: getDefaultNameForUser(message.author) };
    amountArg = args[0];
    lenderArg = args[1];
    noteArgs = args.slice(2);
  } else {
    if (args.length < 4) {
      return message.channel.send(
        "Usage:\n`!loan <amount> <lender> [note...]`\n`!loan <@user|name> <amount> <lender> [note...]`"
      );
    }

    borrower = resolvePersonFromArgOrMention(message, args[0]);
    amountArg = args[1];
    lenderArg = args[2];
    noteArgs = args.slice(3);
  }

  const amount = parseAmount(amountArg);
  if (amount === null) return message.channel.send("Amount must be a positive number.");

  const lender = { id: null, name: String(lenderArg || "").trim() };
  if (!lender.name) return message.channel.send("Lender cannot be empty.");

  const loanId = generateLoanId(borrower.name, lender.name);
  const now = new Date().toISOString();
  const note = noteArgs.join(" ");

  bankData.loans[loanId] = {
    borrowerName: borrower.name || "Unknown",
    lenderName: lender.name || "Unknown",
    balance: amount,
    status: "open",
    timestamp: now,
    note: note || "",
  };

  recordLoanTransaction(loanId, "loan", amount, message.author.id, note || "Loan created");

  return message.channel.send(
    `**__Loan created.__**\n` +
      `• Borrower: **${bankData.loans[loanId].borrowerName}**\n` +
      `• Lender: **${bankData.loans[loanId].lenderName}**\n` +
      `• Initial debt: **${amount} GP**\n` +
      `• Note: **${note}**`
  );
}

async function repayCommand(message, args) {
  // !repay <amount> <lender|loan_id>
  // !repay <@user|name> <amount> <lender|loan_id>
  const usage = "Usage:\n`!repay <amount> <lender|loan_id>`\n`!repay <@user|name> <amount> <lender|loan_id>`";
  if (args.length < 2) return message.channel.send(usage);

  // Parse arguments
  let borrower, amountArg, targetArg;
  const firstIsNumber = Number.isFinite(Number(args[0])) && !message.mentions.users.size;
  if (firstIsNumber) {
    borrower = { id: message.author.id, name: getDefaultNameForUser(message.author) };
    amountArg = args[0];
    targetArg = args[1];
  } else {
    if (args.length < 3) {
      return message.channel.send(usage);
    }
    borrower = resolvePersonFromArgOrMention(message, args[0]);
    amountArg = args[1];
    targetArg = args[2];
  }
  const amount = parseAmount(amountArg);
  if (amount === null) return message.channel.send("Amount must be a positive number.");
  const actorId = message.author.id;

  // Get loan ID
  let loanId;
  if (isLoanId(targetArg)) {
    loanId = normalizeLoanId(targetArg);
  } else {
    const lenderName = String(targetArg || "").trim();
    if (!lenderName) return message.channel.send("Lender cannot be empty.");
    const matches = findOpenLoans({borrowerName: borrower.name, lenderName: lenderName});
    if (!matches.length) {
      return message.channel.send(
        `No unresolved loan found for borrower **${borrower.name}** with lender **${lenderName}**.`
      );
    }
    if (matches.length > 1) {
      const loanNoteMappings = matches.map((m) => `• **${m.loanId}** - ${m.note}`).join("\n");
      return message.channel.send(`Borrower **${borrower.name}** has **multiple unresolved loans** with lender **${lenderName}**.\n` +
        `Use \`!repay <amount> <loan_id>\` instead.\n` +
        `Loan IDs:\n${loanNoteMappings}`);
    }
    loanId = matches[0].loanId;
  }
  
  // Validation
  const loan = getLoan(loanId);
  if (!loan) return message.channel.send(`Loan **${loanId}** not found.`);
  if (loan.status === "resolved") return message.channel.send(`Loan **${loanId}** is already resolved.`);
  const borrowerMatches = eqName(loan.borrowerName, borrower.name);
  if (!borrowerMatches) {
    return message.channel.send(
      `Loan **${loanId}** does not belong to borrower **${borrower.name}**.`
    );
  }

  // Repay
  const oldBal = Number(loan.balance) || 0;
  const newBal = Math.max(0, oldBal - amount);
  loan.balance = newBal;
  recordLoanTransaction(loanId, "repay", amount, actorId, "");

  // Add info
  let extra = "";
  if (isLoanId(targetArg)) {
    extra += `\nNote: **${loan.note}**`;
  }
  if (newBal === 0) {
    loan.status = "resolved";
    recordLoanTransaction(loanId, "resolve", 0, actorId, "Loan resolved");
    extra += `\nLoan is now **resolved**.`;
  }

  // Send response
  return message.channel.send(
    `Repaid **${amount} GP** to **${loan.lenderName}**.\n` +
      `Loan balance: **${newBal} GP** (was ${oldBal} GP).` +
      extra
  );
}

async function accrueCommand(message, args) {
  // !accrue <amount> <lender|loan_id>
  // !accrue <@user|name> <amount> <lender|loan_id>
  const usage =
    "Usage:\n`!accrue <amount> <lender|loan_id>`\n`!accrue <@user|name> <amount> <lender|loan_id>`";
  if (args.length < 2) return message.channel.send(usage);

  // Parse arguments
  let borrower, amountArg, targetArg;
  const firstIsNumber = Number.isFinite(Number(args[0])) && !message.mentions.users.size;
  if (firstIsNumber) {
    borrower = { id: message.author.id, name: getDefaultNameForUser(message.author) };
    amountArg = args[0];
    targetArg = args[1];
  } else {
    if (args.length < 3) return message.channel.send(usage);
    borrower = resolvePersonFromArgOrMention(message, args[0]);
    amountArg = args[1];
    targetArg = args[2];
  }
  const amount = parseAmount(amountArg);
  if (amount === null) return message.channel.send("Amount must be a positive number.");
  const actorId = message.author.id;

  // Get loan ID
  let loanId;
  if (isLoanId(targetArg)) {
    loanId = normalizeLoanId(targetArg);
  } else {
    const lenderName = String(targetArg || "").trim();
    if (!lenderName) return message.channel.send("Lender cannot be empty.");
    const matches = findOpenLoans({borrowerName: borrower.name, lenderName: lenderName});
    if (!matches.length) {
      return message.channel.send(
        `No unresolved loan found for borrower **${borrower.name}** with lender **${lenderName}**.`
      );
    }
    if (matches.length > 1) {
      const loanNoteMappings = matches.map((m) => `• **${m.loanId}** - ${m.note}`).join("\n");
      return message.channel.send(
        `Borrower **${borrower.name}** has **multiple unresolved loans** with lender **${lenderName}**.\n` +
          `Use \`!accrue <amount> <loan_id>\` instead.\n` +
          `Loan IDs:\n${loanNoteMappings}`
      );
    }
    loanId = matches[0].loanId;
  }

  // Validation
  const loan = getLoan(loanId);
  if (!loan) return message.channel.send(`Loan **${loanId}** not found.`);
  if (loan.status === "resolved") {
    return message.channel.send(`Loan **${loanId}** is resolved; cannot accrue more.`);
  }
  const borrowerMatches = eqName(loan.borrowerName, borrower.name);

  if (!borrowerMatches) {
    return message.channel.send(`Loan **${loanId}** does not belong to borrower **${borrower.name}**.`);
  }

  // Accrue
  const oldBal = Number(loan.balance) || 0;
  const newBal = oldBal + amount;
  loan.balance = newBal;
  recordLoanTransaction(loanId, "accrue", amount, actorId, "");

  // Add info
  let extra = "";
  if (isLoanId(targetArg)) {
    extra += `\nNote: **${loan.note}**`;
  }

  // Send response
  return message.channel.send(
    `Accrued **${amount} GP** on loan with lender **${loan.lenderName}**.\n` +
      `Loan balance: **${newBal} GP** (was ${oldBal} GP).` +
      extra
  );
}


function debtCommand(message, args) {
  // !debt
  // !debt <@user|name>
  let targetName = null;

  if (args.length === 0) {
    const targetUser = message.author;
    targetName = getDefaultNameForUser(targetUser);
  } else if (message.mentions.users.size > 0) {
    const targetUser = message.mentions.users.first();
    targetName = getDefaultNameForUser(targetUser);
  } else {
    targetName = String(args[0]).trim();
  }

  const openLoans = Object.entries(bankData.loans || {})
    .filter(([, loan]) => loan && loan.status !== "resolved")
    .filter(([, loan]) => {
      return eqName(loan.borrowerName, targetName);
    })
    .map(([loanId, loan]) => ({
      loanId,
      lenderName: loan.lenderName || "Unknown",
      balance: Number(loan.balance) || 0,
    }))
    .filter((x) => x.balance > 0)
    .sort((a, b) => b.balance - a.balance);

  if (openLoans.length === 0) return message.channel.send(`No unresolved loans for **${targetName}**.`);

  const lines = openLoans.map((l) => {
    const loan = bankData.loans[l.loanId];
    const note = loan && loan.note ? ` - _${loan.note}_` : "";
    return `• **${l.loanId}** - **${l.balance} GP** (lender: **${l.lenderName}**)${note}`;
  }); 
  const total = openLoans.reduce((s, l) => s + l.balance, 0);

  return message.channel.send(`Unresolved loans for **${targetName}**:\n${lines.join("\n")}\nTotal: **${total} GP**`);
}

function debtorsCommand(message, args) {
  // !debtors
  // !debtors <@user|name>
  let targetUser = null;
  let targetName = null;

  if (args.length === 0) {
    targetUser = message.author;
    targetName = getDefaultNameForUser(targetUser);
  } else if (message.mentions.users.size > 0) {
    targetUser = message.mentions.users.first();
    targetName = getDefaultNameForUser(targetUser);
  } else {
    targetName = String(args[0]).trim();
  }

  const openLoans = Object.entries(bankData.loans || {})
    .filter(([, loan]) => loan && loan.status !== "resolved")
    .filter(([, loan]) => {
      if (targetUser) return loan.lenderId === targetUser.id;
      return eqName(loan.lenderName, targetName);
    })
    .map(([loanId, loan]) => ({
      loanId,
      borrowerName: loan.borrowerName || "Unknown",
      balance: Number(loan.balance) || 0,
    }))
    .filter((x) => x.balance > 0)
    .sort((a, b) => b.balance - a.balance);

  if (openLoans.length === 0) return message.channel.send(`No unresolved loans where **${targetName}** is the lender.`);

  const lines = openLoans.map((l) => {
    const loan = bankData.loans[l.loanId];
    const note = loan && loan.note ? ` - _${loan.note}_` : "";
    return `• **${l.loanId}** - **${l.balance} GP** (borrower: **${l.borrowerName}**)${note}`;
  });
  const total = openLoans.reduce((s, l) => s + l.balance, 0);

  return message.channel.send(
    `Unresolved loans where **${targetName}** is the lender:\n${lines.join("\n")}\nTotal owed to lender: **${total} GP**`
  );
}

function leaderboardCommand(message, args) {
  // !leaderboard
  // !leaderboard <count>
  let count = 10;
  if (args[0]) {
    const n = Number(args[0]);
    if (Number.isFinite(n) && n > 0) count = Math.min(10, Math.floor(n));
  }

  let fullMessage = "";

  const gpEntries = getTopGpEntries(count);
  if (gpEntries.length) {
    const gpEntriesFormatted = gpEntries
      .map(([name, bal], idx) => `**${idx + 1}.** ${name} - **${bal} GP**`)
      .join("\n");
    fullMessage += `**Wealth Leaderboard (Top ${gpEntries.length})**\n${gpEntriesFormatted}`;
  }

  const debtEntries = getTopDebtEntries(count);
  if (debtEntries.length) {
    const debtEntriesFormatted = debtEntries
      .map((row, idx) => `**${idx + 1}.** ${row.name} - **${row.debt} GP**`)
      .join("\n");
    const debtSection = `**Debt Leaderboard (Top ${debtEntries.length})**\n${debtEntriesFormatted}`;
    fullMessage += fullMessage ? `\n\n${debtSection}` : debtSection;
  }

  if (!fullMessage) return message.channel.send("No accounts with a positive balance or debt yet.");
  return message.channel.send(fullMessage);
}

// ============= LOGIN =============
client.login(process.env.DISCORD_BOT_TOKEN);
