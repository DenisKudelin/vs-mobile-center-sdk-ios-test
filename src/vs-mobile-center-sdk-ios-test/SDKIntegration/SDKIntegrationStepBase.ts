import * as Promise from "bluebird";

export abstract class SDKIntegrationStepBase<T> {
    protected nextStep: SDKIntegrationStepBase<T>;
    protected context: T;

    public run(context: T): Promise<void> {
        this.context = context;
        return Promise
            .try(() => this.step())
            .then(() => this.runNextStep());
    }

    protected abstract step();

    private runNextStep(): Promise<void> {
        if (this.nextStep) {
            return this.nextStep.run(this.context);
        }
    }
}