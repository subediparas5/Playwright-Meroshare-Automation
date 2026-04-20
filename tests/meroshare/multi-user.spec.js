const { test } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const {
  performLogin,
  isLoginSuccessful,
  clickMyASBA,
  checkForApplyButton,
  clickApplyButton,
  clickShareRow,
  verifyShareDetails,
  goBackToMyASBA,
  fillIPOApplication,
  submitIPOApplication,
  checkApplicationStatus,
  initBot,
  sendMessage,
  notifyError,
  navigateWithRetry,
  waitForElementWithRetry,
  retryWithBackoff,
} = require('./helpers');
const { users, telegram } = require('../../users.config');

/** Last run's failures (by Meroshare username). Kept outside `test-results/` so Playwright does not wipe it before retry runs. */
const FAILED_USERS_FILE = path.join(__dirname, '..', '..', 'meroshare-last-failures.json');

function loadFailedUsernames() {
  try {
    const raw = fs.readFileSync(FAILED_USERS_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.failedUsernames) ? data.failedUsernames : [];
  } catch {
    return [];
  }
}

function saveFailedUsernames(failedUsernames) {
  const dir = path.dirname(FAILED_USERS_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    FAILED_USERS_FILE,
    JSON.stringify(
      {
        failedUsernames,
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    'utf8'
  );
}

/** @param {object[]} allUsers */
function getUsersToProcess(allUsers) {
  const failedUsernames = loadFailedUsernames();
  if (failedUsernames.length === 0) {
    console.log(
      'No meroshare-last-failures.json on record — nothing to retry.'
    );
    return { users: [], mode: 'retry-empty' };
  }
  const filtered = allUsers.filter((u) => u.username && failedUsernames.includes(u.username));
  if (filtered.length === 0) {
    console.log(
      'Saved failures do not match any configured users — nothing to retry.'
    );
    return { users: [], mode: 'retry-nomatch' };
  }
  console.log(
    `Retrying ${filtered.length} failed user(s): ${filtered
      .map((u) => u.name || u.username)
      .join(', ')}`
  );
  return { users: filtered, mode: 'retry' };
}

/** Max wall-clock per user so one stuck session cannot consume the whole test run. */
const USER_SLOT_MS = 180000;
/** Extra time for Telegram summary and between-user delays. */
const SUMMARY_BUFFER_MS = 120000;

async function withPerUserBudget(ms, fn) {
  let timeoutId;
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Per-user time budget exceeded (${ms}ms)`)),
          ms
        );
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

test.describe('MeroShare Multi-User IPO Automation', () => {
  test('should check for IPO and auto-apply for all users', async ({ browser }) => {
    const telegramToken = telegram.token;
    const telegramChatId = telegram.chatId;
    
    // Initialize Telegram bot once
    if (telegramToken) {
      try {
        initBot(telegramToken);
        console.log('Telegram bot initialized successfully');
      } catch (error) {
        console.error('Failed to initialize Telegram bot:', error.message);
      }
    }
    
    // Check if any valid users exist
    if (!users || users.length === 0) {
      console.log('No valid users configured. Please check users.config.js');
      if (telegramChatId && telegramToken) {
        await notifyError(telegramChatId, 'No valid users configured for IPO automation.');
      }
      return;
    }

    const { users: usersToProcess, mode } = getUsersToProcess(users);
    if (usersToProcess.length === 0) {
      return;
    }

    test.setTimeout(
      USER_SLOT_MS * Math.max(1, usersToProcess.length) + SUMMARY_BUFFER_MS
    );

    console.log(
      mode === 'full'
        ? `Found ${usersToProcess.length} valid user(s) to process`
        : `Processing ${usersToProcess.length} user(s) (retry failed only)`
    );
    
    // Track results for all users
    const results = [];
    let ipoAvailable = null; // Cache IPO availability after first user check
    let cachedIpoDetails = null;
    let cachedVerification = null;
    
    // Process each user sequentially
    for (let i = 0; i < usersToProcess.length; i++) {
      const user = usersToProcess[i];
      const userLabel = user.name || `User ${i + 1}`;
      
      console.log(`\n========== Processing ${userLabel} (${i + 1}/${usersToProcess.length}) ==========`);
      
      // Create a new context and page for each user (isolated sessions)
      const context = await browser.newContext();
      const page = await context.newPage();
      
      let userResult = {
        user: userLabel,
        username: user.username,
        status: 'unknown',
        message: '',
        ipoDetails: null
      };

      const perUserBudgetMs = USER_SLOT_MS;

      try {
        await withPerUserBudget(perUserBudgetMs, async () => {
        // Navigate to login page
        const loginUrl = 'https://meroshare.cdsc.com.np/#/login';
        await navigateWithRetry(page, loginUrl, {
          maxRetries: 5,
          timeout: 120000,
          waitUntil: 'domcontentloaded',
        });
        
        // Wait for login form
        try {
          await waitForElementWithRetry(page, [
            'form',
            'input#username',
            'select2#selectBranch',
            'input[type="text"]',
          ], {
            timeout: 60000,
            maxRetries: 3,
            reloadOnFail: true,
          });
        } catch (e) {
          console.log('Could not find login form elements, continuing anyway...');
          await page.waitForTimeout(2000);
        }
        
        // Login
        await retryWithBackoff(
          async () => {
            await performLogin(page, {
              username: user.username,
              password: user.password,
              dp: user.dp
            });
          },
          {
            maxRetries: 3,
            initialDelay: 3000,
            onRetry: async (error, attempt) => {
              console.log(`${userLabel}: Login attempt ${attempt} failed: ${error.message}. Retrying...`);
              try {
                await page.reload({ timeout: 60000, waitUntil: 'domcontentloaded' });
                await page.waitForTimeout(2000);
              } catch (e) {
                console.log('Page reload failed, continuing...');
              }
            }
          }
        );
        
        await page.waitForTimeout(5000);
        
        const loginSuccess = await isLoginSuccessful(page);
        if (!loginSuccess) {
          throw new Error('Login failed');
        }
        
        console.log(`${userLabel}: Login successful`);
        
        // Navigate to My ASBA
        await retryWithBackoff(
          async () => {
            await clickMyASBA(page);
          },
          {
            maxRetries: 3,
            initialDelay: 2000,
          }
        );
        await page.waitForTimeout(5000);
        
        // Check for IPO
        const applyInfo = await retryWithBackoff(
          async () => {
            const info = await checkForApplyButton(page);
            if (info.found || info.reason) {
              return info;
            }
            throw new Error('Page not fully loaded');
          },
          {
            maxRetries: 3,
            initialDelay: 3000,
          }
        );
        
        // No IPO available or already applied
        if (!applyInfo.found) {
          if (applyInfo.alreadyApplied) {
            console.log(`${userLabel}: IPO already applied`);
            userResult.status = 'already_applied';
            userResult.message = 'IPO already applied';
            userResult.ipoDetails = applyInfo.ipoDetails;
            cachedIpoDetails = applyInfo.ipoDetails;
          } else {
            console.log(`${userLabel}: No IPO available`);
            userResult.status = 'no_ipo';
            userResult.message = 'No Ordinary Shares IPO available';
          }
          ipoAvailable = false;
        } else {
          // IPO found
          ipoAvailable = true;
          userResult.ipoDetails = applyInfo.ipoDetails;
          cachedIpoDetails = applyInfo.ipoDetails;
          
          // Verify share details (min 10 units, Rs 100 per share)
          const clickedRow = await clickShareRow(page, applyInfo);
          if (!clickedRow) {
            throw new Error('Could not click on share row to view details');
          }
          
          const verification = await verifyShareDetails(page, 100, 10);
          cachedVerification = verification;
          
          if (!verification.valid) {
            // Criteria don't match - needs manual review
            userResult.status = 'needs_review';
            userResult.message = verification.reason;
            userResult.ipoDetails = {
              ...userResult.ipoDetails,
              shareValuePerUnit: verification.shareValuePerUnit,
              minUnit: verification.minUnit
            };
            console.log(`${userLabel}: IPO needs manual review - ${verification.reason}`);
          } else {
            // Criteria match - proceed with application
            await goBackToMyASBA(page);
            await page.waitForTimeout(2000);
            
            let applyInfoRefresh = await checkForApplyButton(page);
            if (!applyInfoRefresh.found) {
              throw new Error('Could not find Apply button after verification');
            }
            
            // Check if user has all required credentials
            if (!user.bank || !user.accountNumber || !user.kitta || !user.crn || !user.txnPin) {
              userResult.status = 'needs_review';
              userResult.message = 'Missing required credentials (bank, account, kitta, crn, or txnPin)';
              console.log(`${userLabel}: Missing credentials for auto-apply`);
            } else {
              // Set TXN PIN in env for this user (submitIPOApplication reads from env)
              process.env.MEROSHARE_TXN_PIN = user.txnPin;
              
              // Fill and submit application
              let submitResult = null;
              await retryWithBackoff(
                async () => {
                  await clickApplyButton(page, applyInfoRefresh);
                  await page.waitForTimeout(3000);
                  
                  await fillIPOApplication(page, {
                    bank: user.bank,
                    accountNumber: user.accountNumber,
                    kitta: user.kitta,
                    crn: user.crn
                  });
                  await page.waitForTimeout(2000);
                  
                  submitResult = await submitIPOApplication(page);
                  if (!submitResult.clickedApply) {
                    throw new Error(submitResult.error || 'Failed to submit IPO application');
                  }
                  await page.waitForTimeout(3000);
                },
                {
                  maxRetries: 2,
                  initialDelay: 3000,
                  onRetry: async (error, attempt) => {
                    console.log(`${userLabel}: Application attempt ${attempt} failed: ${error.message}. Retrying...`);
                    try {
                      await goBackToMyASBA(page);
                      await page.waitForTimeout(2000);
                      const refreshed = await checkForApplyButton(page);
                      if (refreshed.found) {
                        applyInfoRefresh = refreshed;
                      }
                    } catch (e) {}
                  }
                }
              );
              
              // Check application status
              await page.waitForTimeout(3000);
              
              if (!page.isClosed()) {
                const status = await checkApplicationStatus(page);
                if (status.success) {
                  userResult.status = 'success';
                  userResult.message = status.message || 'Application submitted';
                  console.log(`${userLabel}: IPO application submitted successfully!`);
                } else {
                  userResult.status = 'failed';
                  userResult.message = status.message || 'Application failed';
                  console.log(`${userLabel}: Application failed - ${status.message}`);
                }
              } else {
                userResult.status = 'unknown';
                userResult.message = 'Page closed unexpectedly';
              }
            }
          }
        }

        });

      } catch (error) {
        console.error(`${userLabel}: Error - ${error.message}`);
        userResult.status = 'failed';
        userResult.message = error.message;
      } finally {
        // Close context for this user
        await context.close();
      }
      
      results.push(userResult);
      
      // Small delay between users
      if (i < usersToProcess.length - 1) {
        console.log('Waiting before next user...');
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }

    const failedUsernames = results
      .filter((r) => r.status === 'failed' && r.username)
      .map((r) => r.username);
    saveFailedUsernames(failedUsernames);

    // Send consolidated Telegram notification
    if (telegramChatId && telegramToken) {
      await sendMultiUserNotification(telegramChatId, results, cachedIpoDetails, sendMessage);
    }
    
    // Log summary
    console.log('\n========== SUMMARY ==========');
    for (const result of results) {
      console.log(`${result.user}: ${result.status} - ${result.message}`);
    }
    
    // Fail test if any user failed
    const failures = results.filter(r => r.status === 'failed');
    if (failures.length > 0) {
      throw new Error(`${failures.length} user(s) failed: ${failures.map(f => f.user).join(', ')}`);
    }
  });
});

/**
 * Send consolidated multi-user notification to Telegram
 * @param {string} chatId - Telegram chat ID
 * @param {Array} results - Array of user results
 * @param {Object} ipoDetails - IPO details
 * @param {Function} sendMessageFn - sendMessage function from telegram helper
 */
async function sendMultiUserNotification(chatId, results, ipoDetails, sendMessageFn) {
  // Check if no IPO available for anyone
  const allNoIpo = results.every(r => r.status === 'no_ipo');
  if (allNoIpo) {
    const message = `ℹ️ *No IPO Today* 🤦‍♀️\n\nChecked for ${results.length} user(s) - No Ordinary Shares IPO available.`;
    await sendMessageFn(chatId, message, { parse_mode: 'Markdown' });
    return;
  }
  
  // Build detailed status message
  let message = '';
  
  // Add IPO details if available
  if (ipoDetails && ipoDetails.companyName) {
    message += `🏢 *${ipoDetails.companyName}*\n`;
    if (ipoDetails.shareGroup) {
      message += `Share Group: ${ipoDetails.shareGroup}\n`;
    }
    message += '\n';
  }
  
  // Group results by status
  const successUsers = results.filter(r => r.status === 'success');
  const alreadyAppliedUsers = results.filter(r => r.status === 'already_applied');
  const failedUsers = results.filter(r => r.status === 'failed');
  const reviewUsers = results.filter(r => r.status === 'needs_review');
  const unknownUsers = results.filter(r => r.status === 'unknown');
  
  // Success section
  if (successUsers.length > 0) {
    message += `✅ *Applied Successfully (${successUsers.length})*\n`;
    for (const user of successUsers) {
      message += `  • ${user.user}\n`;
    }
    message += '\n';
  }
  
  // Already Applied section
  if (alreadyAppliedUsers.length > 0) {
    message += `✅ *Already Applied (${alreadyAppliedUsers.length})*\n`;
    for (const user of alreadyAppliedUsers) {
      message += `  • ${user.user}\n`;
    }
    message += '\n';
  }
  
  // Failed section
  if (failedUsers.length > 0) {
    message += `❌ *Failed (${failedUsers.length})*\n`;
    for (const user of failedUsers) {
      message += `  • ${user.user}: ${user.message}\n`;
    }
    message += '\n';
  }
  
  // Needs review section
  if (reviewUsers.length > 0) {
    message += `⚠️ *Needs Manual Review (${reviewUsers.length})*\n`;
    for (const user of reviewUsers) {
      message += `  • ${user.user}: ${user.message}\n`;
    }
    message += '\n';
  }
  
  // Unknown section
  if (unknownUsers.length > 0) {
    message += `❓ *Status Unknown (${unknownUsers.length})*\n`;
    for (const user of unknownUsers) {
      message += `  • ${user.user}\n`;
    }
    message += '\n';
  }
  
  // Only show verify message if there are failures, unknowns, or needs review
  if (failedUsers.length > 0 || unknownUsers.length > 0 || reviewUsers.length > 0) {
    message += `\n⚠️ Please verify at meroshare.cdsc.com.np`;
  }
  message += `\n\n_Time: ${new Date().toLocaleString()}_`;
  
  await sendMessageFn(chatId, message, { parse_mode: 'Markdown' });
}
