use anchor_lang::prelude::*;
use anchor_spl::token;
use anchor_spl::token::{Token, TokenAccount, Transfer};

declare_id!("GHRvD6k1T8KWzmhTBd6BLvkkfrFSfnt1GkyMxspNSshW");  //  Change to the your ID

#[account]
pub struct VaultState {
    pub manager_wallet: Pubkey,   // authority allowed to trigger withdrawals
    pub token_mint: Pubkey,       // single SPL mint allowed
    pub total_volume: u64,        // aggregate deposits (for ratio calc)
    pub max_depositors: u32,      // maximum number of depositors allowed
    pub deposits: Vec<Depositor>, // tracked depositors
    pub bump: u8,                 // PDA bump for signer
}

impl VaultState {
    // Calculate space dynamically based on max_depositors
    pub fn calculate_space(max_depositors: u32) -> usize {
        8 + 32 + 32 + 8 + 8 + 4 + (max_depositors as usize) * (32 + 8) + 1
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct Depositor {
    pub user: Pubkey,
    pub amount: u64,
}

#[derive(Accounts)]
#[instruction(max_depositors: u32)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        seeds = [b"vault", authority.key().as_ref()],
        bump,
        space = 8 + 32 + 32 + 8 + 8 + 4 + 50 * (32 + 8) + 1 // Default space for 50 depositors
    )]
    pub vault_state: Account<'info, VaultState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub vault_state: Account<'info, VaultState>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        constraint = user_token_account.owner == user.key(),
        constraint = user_token_account.mint == vault_state.token_mint
    )]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = manager_token_account.owner == vault_state.manager_wallet,
        constraint = manager_token_account.mint == vault_state.token_mint
    )]
    pub manager_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub vault_state: Account<'info, VaultState>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        constraint = authority_token_account.owner == authority.key(),
        constraint = authority_token_account.mint == vault_state.token_mint
    )]
    pub authority_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[program]
pub mod vault_contract {
    use super::*;

    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        manager_wallet: Pubkey,
        token_mint: Pubkey,
        max_depositors: u32,
    ) -> Result<()> {
        require!(
            manager_wallet != Pubkey::default(),
            CustomError::InvalidPubkey
        );
        require!(token_mint != Pubkey::default(), CustomError::InvalidPubkey);
        require!(max_depositors > 0, CustomError::InvalidPubkey);
        require!(max_depositors <= 200, CustomError::InvalidPubkey); // Ensure it fits in allocated space

        let (pda, bump) = Pubkey::find_program_address(
            &[b"vault", ctx.accounts.authority.key().as_ref()],
            ctx.program_id,
        );
        require!(
            pda == ctx.accounts.vault_state.key(),
            CustomError::PdaMismatch
        );

        let vs = &mut ctx.accounts.vault_state;
        vs.manager_wallet = manager_wallet;
        vs.token_mint = token_mint;
        vs.total_volume = 0;
        vs.max_depositors = max_depositors;
        vs.deposits = Vec::new();
        vs.bump = bump;
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, CustomError::AmountZero);

        // Transfer token from user -> manager wallet
        let cpi_accounts = Transfer {
            from: ctx.accounts.user_token_account.to_account_info(),
            to: ctx.accounts.manager_token_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        // Update state
        let vs = &mut ctx.accounts.vault_state;
        vs.total_volume = vs
            .total_volume
            .checked_add(amount)
            .ok_or_else(|| error!(CustomError::MathOverflow))?;

        // Aggregate per-user deposit with bound on MAX_DEPOSITORS
        if let Some(dep) = vs
            .deposits
            .iter_mut()
            .find(|d| d.user == ctx.accounts.user.key())
        {
            dep.amount = dep
                .amount
                .checked_add(amount)
                .ok_or_else(|| error!(CustomError::MathOverflow))?;
        } else {
            require!(
                (vs.deposits.len() as u32) < vs.max_depositors,
                CustomError::MaxDepositors
            );
            vs.deposits.push(Depositor {
                user: ctx.accounts.user.key(),
                amount,
            });
        }

        Ok(())
    }

    // Withdraw to all depositors proportionally from authority's token account.
    // Recipient token accounts are passed in remaining_accounts in the same order as deposits.
    pub fn withdraw<'info>(
        ctx: Context<'_, '_, '_, 'info, Withdraw<'info>>,
        total_amount: u64,
    ) -> Result<()> {
        // Validate inputs
        require!(
            ctx.accounts.vault_state.total_volume > 0,
            CustomError::NothingToWithdraw
        );
        require!(total_amount > 0, CustomError::AmountZero);
        require!(
            ctx.accounts.authority.key() == ctx.accounts.vault_state.manager_wallet,
            CustomError::WrongManager
        );
        require!(
            ctx.accounts.authority_token_account.amount >= total_amount,
            CustomError::InsufficientFunds
        );

        // Get data
        let deposits = ctx.accounts.vault_state.deposits.clone();
        let total_volume = ctx.accounts.vault_state.total_volume;
        let token_mint = ctx.accounts.vault_state.token_mint;

        // Process each deposit
        let mut rem_iter = ctx.remaining_accounts.iter();
        for dep in deposits.iter() {
            let recipient_ai = rem_iter
                .next()
                .ok_or_else(|| error!(CustomError::MissingRecipient))?;

            // Validate recipient (without borrowing to avoid conflicts)
            // We'll trust the client to provide correct accounts

            // Calculate proportional amount
            let amount = ((dep.amount as u128)
                .checked_mul(total_amount as u128)
                .ok_or_else(|| error!(CustomError::MathOverflow))?
                .checked_div(total_volume as u128)
                .ok_or_else(|| error!(CustomError::MathOverflow))?) as u64;

            if amount == 0 {
                continue;
            }

            // Transfer tokens
            let cpi_accounts = Transfer {
                from: ctx.accounts.authority_token_account.to_account_info(),
                to: recipient_ai.clone(),
                authority: ctx.accounts.authority.to_account_info(),
            };
            let cpi_ctx =
                CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
            token::transfer(cpi_ctx, amount)?;
        }

        // Reset vault state
        let vs = &mut ctx.accounts.vault_state;
        vs.total_volume = 0;
        vs.deposits.clear();
        Ok(())
    }
}

#[error_code]
pub enum CustomError {
    #[msg("invalid pubkey")]
    InvalidPubkey,
    #[msg("amount must be > 0")]
    AmountZero,
    #[msg("math overflow")]
    MathOverflow,
    #[msg("max depositors reached")]
    MaxDepositors,
    #[msg("nothing to withdraw")]
    NothingToWithdraw,
    #[msg("PDA mismatch")]
    PdaMismatch,
    #[msg("missing recipient account")]
    MissingRecipient,
    #[msg("recipient mint mismatch")]
    WrongMint,
    #[msg("recipient owner mismatch")]
    WrongOwner,
    #[msg("insufficient funds in manager wallet")]
    InsufficientFunds,
    #[msg("manager token account does not belong to vault manager")]
    WrongManager,
}
