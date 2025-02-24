import { Context, Markup, Telegraf } from "telegraf";
import { telegrafThrottler } from "telegraf-throttler";
import { message } from "telegraf/filters";
import { Update } from "typegram";
import { config as _config } from "dotenv";
_config(); // Import the .env file
let telegram_key = process.env.TELEGRAM_KEY as string;

import { Configuration, OpenAIApi } from "openai";
import { existsSync, mkdirSync, writeFile, unlink } from "fs";
import { schedule } from "node-cron";

import pkg from "sqlite3";
const { Database } = pkg;

const LIMIT = 10; // Message limit - resets every midnight UTC
const TIMEOUT = 60; // TODO: Timeout in minutes

const MAX_TOKENS = 100;
const TEMPERATURE = 0.7;
const PRIORITY = 0.1;
const MODEL = "text-davinci-003";
// const MODEL = "gpt-3.5-turbo";
const DEFAULT_INTRO = `You are a super advanced AI. You are talking to a human through a chat interface. Try to have a conversation with the human, while pretending to be a human yourself.`;

// OpenAI API setup
const config = new Configuration({
    apiKey: process.env.OPENAI_KEY,
});
const openai = new OpenAIApi(config);

// Bot setup
const bot: Telegraf<Context<Update>> = new Telegraf(telegram_key);

// Database setup
const db = new Database("./users.db");
db.serialize(() => {
    db.run(
        "CREATE TABLE IF NOT EXISTS users (user_id INTEGER, chat_messages TEXT, intro TEXT, message_count INTEGER, date DATETIME)"
    );
    // Create the log table
    db.run(
        "CREATE TABLE IF NOT EXISTS log (user_id INTEGER, message TEXT, intro TEXT, date DATETIME)"
    );
    // Create a trigger that logs the chat history when a user is deleted
    db.run(
        "CREATE TRIGGER IF NOT EXISTS log_chat_history AFTER DELETE ON users BEGIN INSERT INTO log (user_id, message, intro, date) VALUES (old.user_id, old.chat_messages, old.intro, old.date); END"
    );
});

// Add the throttler
const throttler = telegrafThrottler();
bot.use(throttler);

// Update the slash commands
bot.telegram.setMyCommands([
    {
        command: "/start",
        description: "Show instructions on how to use the bot",
    },
    { command: "/help", description: "Show this message" },
    { command: "/info", description: "Show info about the bot" },
    { command: "/ask", description: "Ask the bot a question" },
    { command: "/reset", description: "Reset the chatbot" },
    {
        command: "/limit",
        description:
            "Show how many messages you have left (message limit resets every midnight UTC)",
    },
    { command: "/intro", description: "Show or change the intro message" },
    { command: "/save", description: "Save the conversation to a txt file" },
]);

// Start command
bot.command("start", async (ctx) => {
    const start_text = `To start, just send me a message. To see the list of commands, do /help. To see how much messages you have left, do /limit. The limit resets every midnight UTC.`;

    await ctx.replyWithMarkdown(start_text);
});

// Help command
bot.command("help", async (ctx) => {
    const help_text = `*Commands:*\n/start - Show instructions on how to use the bot\n/help - Show this message\n/info - Show info about the bot\n/ask - Ask the bot a question\n/reset - Reset the chatbot\n/limit - Show how many messages you have left (message limit resets every midnight UTC)\n/intro - Show, change or reset the intro message\n/save - Save the conversation to a txt file`;

    await ctx.replyWithMarkdown(help_text);
});

bot.command("info", async (ctx) => {
    // List the constants
    const info_text = `*Message limit:* \`${LIMIT}\` per day\n*Model:* \`${MODEL}\`\n*Max tokens:* \`${MAX_TOKENS}\`\n*Temperature:* \`${TEMPERATURE}\`\n*Priority:* \ ${PRIORITY}`;

    await ctx.replyWithMarkdown(info_text);
});

bot.command("reset", async (ctx) => {
    // Get users ID
    const user_id = ctx.message.from.id;
    // Get current time
    const date = new Date().toISOString().slice(0, 19).replace("T", " ");
    // If the user exists in the database, fetch his message count and store it in a variable. Delete the user from the database and insert a new user with the same ID and the same message count.
    db.get(
        `SELECT * FROM users WHERE user_id = ${user_id}`,
        async (err: any, row: any) => {
            if (err) {
                await ctx.replyWithMarkdown(`An error has occured: \`${err}\``);
                return;
            }
            if (!row) {
                ctx.reply("You have not started a conversation yet!");
                return;
            }
            let message_count: number;
            if (row.message_count) {
                message_count = row.message_count;
            } else {
                message_count = 0;
            }
            // Save the intro if it is not the default intro
            db.run("DELETE FROM users WHERE user_id = ?", [user_id]);
            // If the intro was changed, make sure to save it
            if (row.intro !== DEFAULT_INTRO) {
                db.run(
                    "INSERT INTO users (user_id, chat_messages, intro, message_count, date) VALUES (?, ?, ?, ?, ?)",
                    [user_id, "", row.intro, message_count, date]
                );
            } else {
                db.run(
                    "INSERT INTO users (user_id, chat_messages, intro, message_count, date) VALUES (?, ?, ?, ?, ?)",
                    [user_id, "", DEFAULT_INTRO, message_count, date] // Q: Why is message_count undefined here? It's defined 10 lines above this line. A: Because it's not defined in the scope of this function. It's defined in the scope of the function above this one.
                );
            }
            ctx.reply(
                "Chat history reset! Your message count has not been reset."
            );
        }
    );
});

bot.command("limit", async (ctx) => {
    // Get users ID
    const user_id = ctx.message.from.id;
    // Get the users message count from the database
    db.get(
        "SELECT * FROM users WHERE user_id = ?",
        [user_id],
        async (err, row: any) => {
            if (err) {
                await ctx.reply(`An error has occured: \`${err}\``);
                return;
            }
            if (!row) {
                ctx.reply("You have not started a conversation yet!");
                return;
            }
            const message_count = row.message_count;
            if (message_count < LIMIT) {
                await ctx.reply(
                    `You have \`${LIMIT - message_count}\` messages left.`
                );
            } else {
                await ctx.reply(
                    `You have reached the message limit of \`${LIMIT}\` messages. Please wait until midnight UTC to send more messages.`
                );
            }
        }
    );
});

bot.command("save", async (ctx) => {
    // Get users ID
    const user_id = ctx.message.from.id;
    // Get the users messages from the database
    db.get(
        `SELECT * FROM users WHERE user_id = ${user_id}`,
        (err, row: any) => {
            if (err) {
                ctx.reply(`An error has occured: ${err}`);
                return;
            }
            if (!row) {
                ctx.reply("You have not started a conversation yet!");
                return;
            }
            const CHAT_MESSAGES = row.chat_messages;
            // Create a file with the users messages
            // Be sure that the saves folder exists do it asynchronously
            if (!existsSync("./saves")) {
                mkdirSync("./saves");
            }
            writeFile(
                `./saves/${user_id}.txt`,
                CHAT_MESSAGES,
                "utf8",
                async (error) => {
                    if (error) {
                        await ctx.replyWithMarkdown(
                            `An error has occured: \`${err}\``
                        );
                        return;
                    }
                    // Send the file to the user with a message
                    ctx.replyWithDocument(
                        { source: `./saves/${user_id}.txt` },
                        { caption: "Here is our chat history so far" }
                    );
                    // Delete the file after 1 minute
                    setTimeout(() => {
                        unlink(`./saves/${user_id}.txt`, async (errorr) => {
                            if (errorr) {
                                await ctx.replyWithMarkdown(
                                    `An error has occured: \`${errorr}\``
                                );
                            }
                        });
                    }, 1 * 60 * 1000);
                }
            );
        }
    );
});

bot.command("ask", async (ctx) => {
    // Get users ID
    const user_id = ctx.message.from.id;
    // Check if the user exists in the database
    db.get(
        `SELECT * FROM users WHERE user_id = ${user_id}`,
        async (err, row: any) => {
            if (err) {
                await ctx.reply(`An error has occured: \`${err}\``);
                return;
            }
            let message_count = 0;
            if (row) {
                message_count = row.message_count;
            } else {
                // Create a new user in the database
                const date = new Date()
                    .toISOString()
                    .slice(0, 19)
                    .replace("T", " ");
                message_count = 0;
                db.run(
                    // Insert with the intro
                    "INSERT INTO users (user_id, chat_messages, intro, message_count, date) VALUES (?, ?, ?, ?, ?)",
                    [user_id, "", DEFAULT_INTRO, message_count, date]
                );
            }
            // If the user has not reached the message limit, send the message to OpenAI and send the response back to the user
            if (message_count < LIMIT) {
                // Get the users message
                const message = ctx.message.text.split(" ").slice(1).join(" ");
                // If the message is empty, send a message to the user
                if (message === "") {
                    ctx.reply("Please enter a message!");
                    return;
                }

                // Format the request to OpenAI
                const request = `You are a super advanced AI. You are talking to a human through a chat interface. Try to have a conversation with the human, while pretending to be a human yourself.\nHuman: ${message}\nAI:`;
                // Send the message to OpenAI
                ctx.sendChatAction("typing");
                const response = await openai.createCompletion({
                    model: MODEL,
                    prompt: request,
                    temperature: TEMPERATURE,
                    top_p: 0.1,
                    n: 1,
                    echo: true,
                    max_tokens: MAX_TOKENS,
                    stop: ["\nHuman:", "\nAI:", "stop"],
                });
                // If there is no response from the server or the response is empty, send a message to the user
                let reply = "";
                if (!response.data) {
                    reply =
                        "An error has occured! Check https://status.openai.com to see if the API is down.";
                }
                if (response.data.choices[0].text === "") {
                    reply = "I don't know what to say!";
                } else {
                    reply = response.data.choices[0].text as string;
                }
                // Trim the response
                reply = reply.trim();
                // Send the response to the user
                ctx.reply(reply);
                // Update the users message count in the database
                db.run(
                    "UPDATE users SET message_count = message_count + 1 WHERE user_id = ?",
                    [user_id]
                );
            } else {
                await ctx.reply(
                    `You have reached the message limit of \`${LIMIT}\` messages. Please wait until midnight UTC to send more messages.`
                );
            }
        }
    );
});

bot.command("intro", async (ctx) => {
    // If the message is empty, send a message to the user with his current intro. If not, update the intro in the database and send a message to the user with the new intro.
    // Get users ID
    const user_id = ctx.message.from.id;
    // Check if the user exists in the database
    db.get(
        "SELECT * FROM users WHERE user_id = ?",
        [user_id],
        async (err, row: any) => {
            if (err) {
                await ctx.replyWithMarkdown(`An error has occured: \`${err}\``);
                return;
            }
            // Check if the user wanted to reset his intro by sending /intro reset or /intro default or /intro none or /intro clear
            let intro = "";
            if (
                ctx.message.text.split(" ").slice(1).join(" ") === "reset" ||
                ctx.message.text.split(" ").slice(1).join(" ") === "default" ||
                ctx.message.text.split(" ").slice(1).join(" ") === "none" ||
                ctx.message.text.split(" ").slice(1).join(" ") === "clear"
            ) {
                intro = DEFAULT_INTRO;
            } else {
                // Check if the user even sent an intro
                if (ctx.message.text.split(" ").slice(1).join(" ") === "") {
                    intro = "";
                } else {
                    // Get the users intro
                    intro = ctx.message.text.split(" ").slice(1).join(" ");
                }
            }
            // If the user sent no intro, send a message to the user with his current intro
            if (intro === "") {
                // Check if the user has an intro
                await ctx.replyWithMarkdown(`Your intro is: \`${row.intro}\``);
                return;
            }
            // Update the users intro in the database
            db.run("UPDATE users SET intro = ? WHERE user_id = ?", [
                intro,
                user_id,
            ]);
            // Send the intro to the user
            await ctx.replyWithMarkdown(
                `Your intro has been set to:\n\`${intro}\``
            );
        }
    );
});

// On every message sent (except in a group chat)
bot.on(message("text"), async (ctx) => {
    // Check if the message is from a group chat
    if (
        ctx.message.chat.type === "group" ||
        ctx.message.chat.type === "supergroup"
    ) {
        return;
    }
    // Get users ID
    const user_id = ctx.message.from.id;
    // Get the users message count from the database
    // Check if the user exists in the database
    db.get(
        `SELECT * FROM users WHERE user_id = ${user_id}`,
        async (err, row: any) => {
            if (err) {
                await ctx.reply(`An error has occured: \`${err}\``);
                return;
            }

            let message_count = 0;
            let chat_messages = "";
            let intro = "";
            if (row) {
                // Get his info from the database
                message_count = row.message_count;
                chat_messages = row.chat_messages;
                intro = row.intro;
            } else {
                // Create a new user in the database
                const date = new Date()
                    .toISOString()
                    .slice(0, 19)
                    .replace("T", " ");
                message_count = 0;
                chat_messages = "";
                db.run(
                    "INSERT INTO users (user_id, chat_messages, intro, message_count, date) VALUES (?, ?, ?, ?, ?)",
                    [user_id, chat_messages, DEFAULT_INTRO, message_count, date]
                );
            }
            // Check if the user has reached the message limit
            if (message_count > LIMIT) {
                await ctx.reply(
                    `You have reached the message limit of \`${LIMIT}\` messages. Please wait until midnight UTC to send more messages.`
                );
                return;
            } else {
                // Get the users message
                const message: string = ctx.message.text;
                // If the message is empty, send a message to the user
                if (message.trim() === "") {
                    await ctx.reply(
                        "Please send a message that is not empty. How did you even manage to do that?"
                    );
                    return;
                }
                // Format the request to OpenAI (if the user is new, send a intro message too)
                let request = "";
                // If the user has a custom intro, use that. If not, use the default intro. Also if the user has sent messages before, add them to the request. If not, do not add them to the request.
                if (chat_messages === "") {
                    request = `${intro}\nHuman: ${message}\nAI:`;
                } else {
                    request = `${intro}\n${chat_messages}\nHuman: ${message}\nAI:`;
                }

                // Send a typing action to the user
                ctx.sendChatAction("typing");
                // Send the message to OpenAI
                // For debugging purposes, print the request to the console
                // console.log(`===\n${request}\n===`);
                const response = await openai.createCompletion({
                    model: MODEL,
                    prompt: request,
                    temperature: TEMPERATURE,
                    top_p: PRIORITY,
                    n: 1,
                    echo: true,
                    max_tokens: MAX_TOKENS,
                    stop: ["\nHuman:", "\nAI:"],
                });
                // Send the response back to the user
                let reply = "";
                if (!response.data) {
                    reply =
                        "An error has occured! Check https://status.openai.com to see if the API is down.";
                }
                if (response.data.choices[0].text === "") {
                    reply = "I don't know what to say!";
                } else {
                    reply = response.data.choices[0].text as string;
                }
                // Send the response to the user
                reply = reply.trim();
                ctx.reply(reply);
                db.run(
                    "UPDATE users SET message_count = message_count + 1 WHERE user_id = ?",
                    [user_id]
                );
                // Add a whitespace to the beginning of the reply to make it look better
                reply = ` ${reply}`;
                let new_chat_messages = "";
                // If the user is new, add the intro message
                if (chat_messages === "") {
                    new_chat_messages = `${intro}\nHuman: ${message}\nAI:${reply}`;
                } else {
                    new_chat_messages = `${chat_messages}\nHuman: ${message}\nAI:${reply}`;
                }
                db.run("UPDATE users SET chat_messages = ? WHERE user_id = ?", [
                    new_chat_messages,
                    user_id,
                ]);
            }
        }
    );
});

// Every day at 23:00 (UTC time in Polish timezone) reset the message count for all users
schedule("0 23 * * *", () => {
    db.run(`UPDATE users SET message_count = 0`);
    // Get the count of users in the database
    db.get(`SELECT COUNT(*) FROM users`, (err, row: any) => {
        if (err) {
            console.log(`An error has occured: ${err}`);
            return;
        }
        console.log(`Reset message count for ${row["COUNT(*)"]} users.`);
    });
});

bot.catch((err) => {
    console.log(`An error has occured: ${err}`);
});

console.log(`Bot started.`);
// Launch the bot
bot.launch();

// Enable graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
