class RuntimeErrors {
    static errUnknownRuntime: Error = new Error('Unknown runtime specified');
    static errRuntimeNotInitialized: Error = new Error(
        'Runtime not initialized'
    );
    static errInvalidSubAccounts: Error = new Error(`Invalid number of sub-accounts. Need at least one`);
}

export default RuntimeErrors;
