#!/usr/bin/env bash
# Usage: check-aws-sso.sh <profile_name> [<sso_target>]

PROFILE=${1:-$AWS_PROFILE}
SSO_TARGET=${2:-$AWS_SSO_PROFILE}

# Detect SSH session and set flags for both tools
AWS_SSH_FLAG=""
MANAGER_SSH_FLAG=""

if [ -n "$SSH_CLIENT" ] || [ -n "$SSH_TTY" ] || who am i | grep -q '[(]'; then
    AWS_SSH_FLAG="--use-device-code"    # For official AWS CLI
    MANAGER_SSH_FLAG="-use-device-code" # For aws-sso-manager
fi

if [ -z "$PROFILE" ]; then
    echo "Error: AWS_PROFILE is not set and no profile argument provided."
    exit 1
fi

# If the Go manager is installed, use it as it handles cross-process locking
if command -v aws-sso-manager >/dev/null 2>&1; then
    aws-sso-manager $MANAGER_SSH_FLAG "$PROFILE" "$SSO_TARGET" 
    exit $?
fi

# Attempt to get identity; if it fails, trigger login
if ! aws sts get-caller-identity --profile "$PROFILE" >/dev/null 2>&1; then
    echo "⚠️ AWS SSO session expired for profile [$PROFILE]. Logging in..."
    # --use-device-code is helpful for SSH/Remote sessions
    if [ -n "$SSO_TARGET" ]; then
        # Try login using profile first, then fall back to sso-session if it fails
        aws sso login --profile "$SSO_TARGET" $AWS_SSH_FLAG 2>/dev/null || aws sso login --sso-session "$SSO_TARGET"
    else
        aws sso login --profile "$PROFILE" $AWS_SSH_FLAG
    fi
else
    echo "✅ AWS SSO session is valid for [$PROFILE]"
fi
